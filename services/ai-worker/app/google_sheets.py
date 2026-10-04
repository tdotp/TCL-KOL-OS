"""Integración EXPLÍCITA con Google Sheets (V2 · Fase 5).

LinkedSource ≠ fetch remoto genérico
------------------------------------
Este módulo es la única salida de red del worker hacia un proveedor externo, y
no es un cliente HTTP genérico:

  · Solo conoce dos hosts: `sheets.googleapis.com` (la API) y
    `oauth2.googleapis.com` (el intercambio del token de la cuenta de servicio).
  · La petición se construye SIEMPRE desde un `spreadsheet_id` ya validado
    (`^[A-Za-z0-9_-]{20,128}$`), nunca desde la URL que el usuario pegó
    (`external_url`). Un id con `/`, `?`, `@` o `.` no pasa el validador, así que
    no puede cambiar el host ni la ruta.
  · Sin redirecciones (`allow_redirects=False`), sin puertos, solo https.
  · Tiempo máximo, tamaño máximo de respuesta, errores sanitizados.

Autenticación
-------------
Cuenta de servicio (server-to-server), alcance de SOLO LECTURA
(`spreadsheets.readonly`). El Sheet se comparte con la cuenta de servicio como
lector. La clave vive únicamente en un archivo fuera del repositorio cuya ruta
llega por `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (el mecanismo ya previsto por DEC-006
y `.env.example`). No se guarda en la base de datos, ni en `audit_events`, ni se
escribe en logs ni en mensajes de error. La firma del JWT y el intercambio del
token los hace la librería oficial `google-auth`; aquí no hay criptografía manual.

Contenido
---------
Se leen VALORES EFECTIVOS (`effectiveValue`): una fórmula existe en Google, pero
aquí solo se consume su resultado; nunca se evalúa nada. La conversión de celdas
reutiliza el contrato tabular de la Fase 4 (`Hoja`, `Celda`, fragmentos con
localizador de rango): XLSX, CSV y Google Sheets convergen en la misma
representación, no en un segundo modelo.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from .parsers.tabular import (
    BOOLEANO,
    ERROR,
    FECHA,
    MAX_CARACTERES_CELDA,
    MAX_CELDAS_TOTAL,
    MAX_COLUMNAS,
    MAX_FILAS_POR_HOJA,
    MAX_HOJAS,
    NUMERO,
    TEXTO,
    Celda,
    Hoja,
    limpiar,
)

# Reutiliza la MISMA conversión numérica que XLSX (enteros tal cual, decimales a
# 15 cifras significativas): el valor de una celda no depende de su origen.
from .parsers.xlsx_parser import _numero_a_texto

logger = logging.getLogger("ai-worker.google_sheets")

PROVEEDOR = "google_sheets"
GENERADOR = "ai-worker/google-sheets-v4@1"
#: Versión del algoritmo de canonicalización del contenido (columna `hash_version`).
VERSION_HASH = "grid-sha256/1"

#: Único alcance solicitado: lectura. Nunca se pide escritura.
ALCANCE_SOLO_LECTURA = "https://www.googleapis.com/auth/spreadsheets.readonly"
HOST_API = "sheets.googleapis.com"
HOST_TOKEN = "oauth2.googleapis.com"  # noqa: S105 — host, no una credencial
URL_TOKEN = f"https://{HOST_TOKEN}/token"
URL_BASE_API = f"https://{HOST_API}/v4/spreadsheets/"
HOSTS_PERMITIDOS = frozenset({HOST_API, HOST_TOKEN})

TIMEOUT_CONEXION_S = 10.0
TIMEOUT_LECTURA_S = 60.0
#: Tope de la respuesta de la API (el JSON con la rejilla completa).
MAX_BYTES_RESPUESTA = 64 * 1024 * 1024

#: Un id de Google Sheets: letras, números, `_` y `-`. Cualquier otra cosa se rechaza.
_ID_VALIDO = re.compile(r"^[A-Za-z0-9_-]{20,128}$")

#: Qué se pide a la API (máscara de campos): rejilla con valor efectivo, tipo de
#: formato de número (para distinguir fechas) y si la celda tiene fórmula. La
#: fórmula en sí no se solicita como texto de negocio ni se guarda.
_CAMPOS = (
    "spreadsheetId,properties(title),"
    "sheets(properties(sheetId,title,index,hidden,sheetType),"
    "data(startRow,startColumn,rowData(values("
    "effectiveValue,userEnteredValue(formulaValue),effectiveFormat(numberFormat(type))))))"
)

_ERRORES_DE_HOJA = {
    "DIVIDE_BY_ZERO": "#DIV/0!",
    "REF": "#REF!",
    "NAME": "#NAME?",
    "N_A": "#N/A",
    "NUM": "#NUM!",
    "VALUE": "#VALUE!",
    "NULL_VALUE": "#NULL!",
    "ERROR": "#ERROR!",
    "LOADING": "#LOADING!",
}


# ─────────────────────────── Errores ──────────────────────────────────────────


class GoogleSheetsError(RuntimeError):
    """Fallo de la integración. El mensaje es apto para la interfaz y NUNCA lleva
    credenciales, tokens ni cuerpos de respuesta de Google.

    `reintentable=True` solo para fallos transitorios (timeout, 429, 5xx, red).
    Credenciales inválidas, 403, 404 o un libro fuera de límites son
    deterministas: reintentarlos daría lo mismo, así que no gastan reintentos.
    """

    def __init__(
        self,
        codigo: str,
        mensaje: str,
        *,
        reintentable: bool = False,
        espera_s: int | None = None,
    ) -> None:
        super().__init__(mensaje)
        self.codigo = codigo
        self.reintentable = reintentable
        #: Espera sugerida por el proveedor (`Retry-After`), acotada.
        self.espera_s = espera_s


# ─────────────────────────── Transporte ───────────────────────────────────────


@dataclass(frozen=True)
class RespuestaHttp:
    status: int
    headers: Mapping[str, str]
    cuerpo: bytes


class Transporte(Protocol):
    """Una petición GET ya autenticada. Lo único que la integración necesita de
    la red; las pruebas lo sustituyen por uno controlado (sin Google real)."""

    def get(
        self,
        url: str,
        params: Mapping[str, str],
        *,
        timeout: tuple[float, float],
        max_bytes: int,
    ) -> RespuestaHttp: ...


def validar_url_de_api(url: str) -> None:
    """Defensa en profundidad: la URL final debe ser la API de Sheets, nada más."""
    partes = urlparse(url)
    if (
        partes.scheme != "https"
        or partes.hostname != HOST_API
        or partes.port is not None
        or partes.username is not None
        or partes.password is not None
        or not partes.path.startswith("/v4/spreadsheets/")
    ):
        raise GoogleSheetsError(
            "GOOGLE_HOST_NOT_ALLOWED", "Destino no permitido para la integración con Google."
        )


def validar_id_de_libro(spreadsheet_id: str) -> str:
    if not isinstance(spreadsheet_id, str) or not _ID_VALIDO.match(spreadsheet_id):
        raise GoogleSheetsError("INVALID_SOURCE_URL", "El identificador del Google Sheet no es válido.")
    return spreadsheet_id


def _cuerpo_con_tope(respuesta: Any, max_bytes: int) -> bytes:
    trozos: list[bytes] = []
    total = 0
    for trozo in respuesta.iter_content(chunk_size=64 * 1024):
        total += len(trozo)
        if total > max_bytes:
            raise GoogleSheetsError(
                "GOOGLE_RESPONSE_TOO_LARGE",
                "La respuesta de Google excede el tamaño máximo permitido. Divida el libro.",
            )
        trozos.append(trozo)
    return b"".join(trozos)


class TransporteGoogle:
    """Transporte real: `requests` + credenciales de la cuenta de servicio
    (`google-auth` firma el JWT y renueva el token)."""

    def __init__(self, credenciales: Any, sesion: Any | None = None) -> None:
        if sesion is None:
            from google.auth.transport.requests import AuthorizedSession

            sesion = AuthorizedSession(credenciales)  # type: ignore[no-untyped-call]
        self._sesion = sesion

    def get(
        self,
        url: str,
        params: Mapping[str, str],
        *,
        timeout: tuple[float, float],
        max_bytes: int,
    ) -> RespuestaHttp:
        validar_url_de_api(url)
        import requests
        from google.auth import exceptions as auth_exc

        try:
            respuesta = self._sesion.get(
                url, params=dict(params), timeout=timeout, stream=True, allow_redirects=False
            )
            try:
                cuerpo = _cuerpo_con_tope(respuesta, max_bytes)
                return RespuestaHttp(
                    status=int(respuesta.status_code),
                    headers={k.lower(): v for k, v in respuesta.headers.items()},
                    cuerpo=cuerpo,
                )
            finally:
                respuesta.close()
        except GoogleSheetsError:
            raise
        except requests.exceptions.Timeout:
            raise GoogleSheetsError(
                "GOOGLE_TIMEOUT", "Google no respondió a tiempo.", reintentable=True
            ) from None
        except (requests.exceptions.ConnectionError, requests.exceptions.ChunkedEncodingError):
            raise GoogleSheetsError(
                "GOOGLE_UNAVAILABLE", "No se pudo conectar con Google.", reintentable=True
            ) from None
        except auth_exc.RefreshError:
            raise GoogleSheetsError(
                "GOOGLE_AUTH_FAILED",
                "Google rechazó las credenciales de la cuenta de servicio. Revise la configuración.",
            ) from None
        except auth_exc.TransportError:
            raise GoogleSheetsError(
                "GOOGLE_UNAVAILABLE", "No se pudo obtener autorización de Google.", reintentable=True
            ) from None
        except requests.exceptions.RequestException:
            raise GoogleSheetsError(
                "GOOGLE_UNAVAILABLE", "Falló la comunicación con Google.", reintentable=True
            ) from None


# ─────────────────────────── Credenciales ─────────────────────────────────────


@dataclass(frozen=True)
class CuentaDeServicio:
    credenciales: Any
    #: Correo de la cuenta de servicio (NO es un secreto): es con quien se comparte el Sheet.
    email: str


def cargar_cuenta_de_servicio(entorno: Mapping[str, str] | None = None) -> CuentaDeServicio:
    """Lee la clave desde el archivo indicado por `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`.

    Todo error aquí es genérico a propósito: ni la ruta del contenido ni un
    fragmento de la clave pueden aparecer en un mensaje.
    """
    env = os.environ if entorno is None else entorno
    ruta = (env.get("GOOGLE_SERVICE_ACCOUNT_KEY_PATH") or "").strip()
    if not ruta:
        raise GoogleSheetsError(
            "GOOGLE_NOT_CONFIGURED",
            "La integración con Google Sheets no está configurada en el servidor.",
        )
    try:
        info = json.loads(Path(ruta).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise GoogleSheetsError(
            "GOOGLE_NOT_CONFIGURED", "No se pudo leer la clave de la cuenta de servicio de Google."
        ) from None

    if (
        not isinstance(info, dict)
        or info.get("type") != "service_account"
        or not isinstance(info.get("client_email"), str)
        or not isinstance(info.get("private_key"), str)
        # El intercambio del token solo puede ir al endpoint oficial de Google.
        or info.get("token_uri", URL_TOKEN) != URL_TOKEN
    ):
        raise GoogleSheetsError(
            "GOOGLE_NOT_CONFIGURED", "La clave de la cuenta de servicio de Google no es válida."
        )
    try:
        from google.oauth2 import service_account

        credenciales = service_account.Credentials.from_service_account_info(  # type: ignore[no-untyped-call]
            info, scopes=[ALCANCE_SOLO_LECTURA]
        )
    except (ValueError, KeyError):
        raise GoogleSheetsError(
            "GOOGLE_NOT_CONFIGURED", "La clave de la cuenta de servicio de Google no es válida."
        ) from None
    return CuentaDeServicio(credenciales=credenciales, email=str(info["client_email"]))


# ─────────────────────────── Valores ──────────────────────────────────────────

#: Época de las series de fecha de Google Sheets.
_EPOCA = datetime(1899, 12, 30)


def _serie_a_texto(serie: float, tipo: str) -> str | None:
    """Serie de fecha de Sheets → ISO 8601 (misma forma que las fechas de XLSX)."""
    if serie < 0 or serie >= 2_958_466:  # 9999-12-31
        return None
    dias = int(serie)
    segundos = round((serie - dias) * 86400)
    if segundos >= 86400:
        dias, segundos = dias + 1, 0
    momento = _EPOCA + timedelta(days=dias, seconds=segundos)
    if tipo == "TIME":
        return momento.strftime("%H:%M:%S")
    if segundos == 0:
        return momento.strftime("%Y-%m-%d")
    return momento.strftime("%Y-%m-%dT%H:%M:%S")


def _celda_de_valor(valor: Mapping[str, Any]) -> tuple[Celda | None, bool, bool]:
    """(celda | None, tiene_formula, formula_sin_valor). Nunca evalúa una fórmula."""
    entrada = valor.get("userEnteredValue") or {}
    tiene_formula = isinstance(entrada, Mapping) and "formulaValue" in entrada
    efectivo = valor.get("effectiveValue")
    if not isinstance(efectivo, Mapping) or not efectivo:
        return None, tiene_formula, tiene_formula

    if "stringValue" in efectivo:
        texto = limpiar(str(efectivo["stringValue"]))
        return (Celda(texto, TEXTO) if texto else None), tiene_formula, False
    if "boolValue" in efectivo:
        return Celda("TRUE" if efectivo["boolValue"] else "FALSE", BOOLEANO), tiene_formula, False
    if "errorValue" in efectivo:
        tipo = str((efectivo["errorValue"] or {}).get("type", "ERROR"))
        return Celda(_ERRORES_DE_HOJA.get(tipo, "#ERROR!"), ERROR), tiene_formula, False
    if "numberValue" in efectivo:
        numero = efectivo["numberValue"]
        if isinstance(numero, bool) or not isinstance(numero, (int, float)):  # noqa: UP038 — Python 3.9
            return None, tiene_formula, False
        formato = (((valor.get("effectiveFormat") or {}).get("numberFormat")) or {}).get("type")
        if formato in ("DATE", "DATE_TIME", "TIME"):
            iso = _serie_a_texto(float(numero), str(formato))
            if iso is not None:
                return Celda(iso, FECHA), tiene_formula, False
        crudo = str(numero) if isinstance(numero, int) else repr(numero)
        return Celda(_numero_a_texto(crudo), NUMERO), tiene_formula, False
    return None, tiene_formula, False


# ─────────────────────────── Libro leído ──────────────────────────────────────


@dataclass
class LibroLeido:
    titulo: str
    hojas: list[Hoja]
    #: nombre de la pestaña → `sheetId` de Google (identidad estable de la pestaña).
    gids: dict[str, int]
    pestanas_sin_rejilla: list[str] = field(default_factory=list)
    #: Revisión declarada por Google. La API v4 de Sheets no expone una: queda
    #: `None` y la igualdad de contenido la decide el hash.
    revision: str | None = None


def _sanear_error_de_api(respuesta: RespuestaHttp) -> tuple[str | None, str | None]:
    """(status, motivo) del cuerpo de error de Google, sin conservar el cuerpo."""
    try:
        cuerpo = json.loads(respuesta.cuerpo.decode("utf-8"))
        error = cuerpo.get("error", {})
        motivo = None
        detalles = error.get("errors") or []
        if detalles and isinstance(detalles[0], Mapping):
            motivo = detalles[0].get("reason")
        return error.get("status"), motivo
    except (ValueError, AttributeError, UnicodeDecodeError):
        return None, None


def _espera_sugerida(respuesta: RespuestaHttp) -> int | None:
    crudo = respuesta.headers.get("retry-after")
    if crudo is not None and crudo.strip().isdigit():
        return min(int(crudo.strip()), 900)
    return None


class ProveedorGoogleSheets:
    """Resuelve un Google Sheet registrado a un libro leído (hojas → filas → celdas)."""

    def __init__(
        self,
        transporte: Transporte,
        *,
        email_cuenta: str | None = None,
        max_bytes: int = MAX_BYTES_RESPUESTA,
    ) -> None:
        self._transporte = transporte
        self._email = email_cuenta
        self._max_bytes = max_bytes

    def _error_http(self, respuesta: RespuestaHttp) -> GoogleSheetsError:
        status = respuesta.status
        estado, motivo = _sanear_error_de_api(respuesta)
        if status == 429 or estado == "RESOURCE_EXHAUSTED" or (
            motivo in {"rateLimitExceeded", "userRateLimitExceeded"}
        ):
            return GoogleSheetsError(
                "GOOGLE_RATE_LIMITED",
                "Google limitó temporalmente las consultas.",
                reintentable=True,
                espera_s=_espera_sugerida(respuesta),
            )
        if status == 401:
            return GoogleSheetsError(
                "GOOGLE_AUTH_FAILED",
                "Google rechazó las credenciales de la cuenta de servicio. Revise la configuración.",
            )
        if status == 403:
            compartir = f" Comparta el Sheet como lector con {self._email}." if self._email else ""
            return GoogleSheetsError(
                "GOOGLE_FORBIDDEN",
                "La cuenta de servicio no tiene acceso a este Google Sheet." + compartir,
            )
        if status == 404:
            return GoogleSheetsError("GOOGLE_NOT_FOUND", "El Google Sheet no existe o no está disponible.")
        if status >= 500:
            return GoogleSheetsError(
                "GOOGLE_UNAVAILABLE",
                "Google no está disponible en este momento.",
                reintentable=True,
                espera_s=_espera_sugerida(respuesta),
            )
        return GoogleSheetsError("GOOGLE_REQUEST_FAILED", f"Google rechazó la solicitud (HTTP {status}).")

    def leer_libro(self, spreadsheet_id: str, *, gid: str | None = None) -> LibroLeido:
        libro_id = validar_id_de_libro(spreadsheet_id)
        url = f"{URL_BASE_API}{libro_id}"
        validar_url_de_api(url)

        respuesta = self._transporte.get(
            url,
            {"includeGridData": "true", "fields": _CAMPOS},
            timeout=(TIMEOUT_CONEXION_S, TIMEOUT_LECTURA_S),
            max_bytes=self._max_bytes,
        )
        if respuesta.status != 200:
            raise self._error_http(respuesta)

        try:
            datos = json.loads(respuesta.cuerpo.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise GoogleSheetsError(
                "GOOGLE_INVALID_RESPONSE", "Google devolvió una respuesta que no se pudo interpretar."
            ) from None
        if not isinstance(datos, Mapping) or not isinstance(datos.get("sheets"), list):
            raise GoogleSheetsError(
                "GOOGLE_INVALID_RESPONSE", "Google devolvió una respuesta con una forma inesperada."
            )
        return self._a_libro(datos, gid)

    def _a_libro(self, datos: Mapping[str, Any], gid: str | None) -> LibroLeido:
        titulo = limpiar(str((datos.get("properties") or {}).get("title", "")))
        hojas: list[Hoja] = []
        gids: dict[str, int] = {}
        sin_rejilla: list[str] = []
        celdas_totales = 0

        pestanas = datos["sheets"]
        if len(pestanas) > MAX_HOJAS:
            raise self._fuera_de_limites(f"El libro tiene más de {MAX_HOJAS} pestañas.")

        for posicion, pestana in enumerate(pestanas, start=1):
            props = pestana.get("properties") or {}
            nombre = str(props.get("title", "")).strip()
            sheet_id = props.get("sheetId")
            if not nombre or not isinstance(sheet_id, int):
                raise GoogleSheetsError(
                    "GOOGLE_INVALID_RESPONSE", "Google devolvió una pestaña sin nombre o identificador."
                )
            if nombre in gids:
                raise GoogleSheetsError(
                    "GOOGLE_INVALID_RESPONSE", "El libro tiene dos pestañas con el mismo nombre."
                )
            gids[nombre] = sheet_id
            if props.get("sheetType", "GRID") != "GRID":
                # Una pestaña de solo gráficos no tiene celdas: se declara, no se ignora en silencio.
                sin_rejilla.append(nombre)
                continue

            hoja = Hoja(
                nombre=nombre,
                indice=int(props.get("index", posicion - 1)) + 1,
                estado="hidden" if props.get("hidden") else "visible",
            )
            for bloque in pestana.get("data") or []:
                fila0 = int(bloque.get("startRow", 0))
                col0 = int(bloque.get("startColumn", 0))
                for desplazamiento_fila, fila in enumerate(bloque.get("rowData") or []):
                    numero = fila0 + desplazamiento_fila + 1
                    celdas: dict[int, Celda] = {}
                    for desplazamiento_col, valor in enumerate((fila or {}).get("values") or []):
                        col = col0 + desplazamiento_col + 1
                        if col > MAX_COLUMNAS:
                            raise self._fuera_de_limites("El libro tiene demasiadas columnas.")
                        celda, formula, sin_valor = _celda_de_valor(valor or {})
                        if formula:
                            hoja.formulas += 1
                        if sin_valor:
                            hoja.formulas_sin_valor += 1
                        if celda is None:
                            continue
                        if len(celda.texto) > MAX_CARACTERES_CELDA:
                            celda = Celda(celda.texto[: MAX_CARACTERES_CELDA - 1] + "…", celda.tipo)
                            hoja.celdas_recortadas += 1
                        celdas[col] = celda
                    if celdas:
                        hoja.filas[numero] = celdas
                        celdas_totales += len(celdas)
                    if len(hoja.filas) > MAX_FILAS_POR_HOJA:
                        raise self._fuera_de_limites(
                            f"La pestaña «{nombre}» tiene más de {MAX_FILAS_POR_HOJA:,} filas con datos."
                        )
                    if celdas_totales > MAX_CELDAS_TOTAL:
                        raise self._fuera_de_limites(
                            f"El libro supera el límite de {MAX_CELDAS_TOTAL:,} celdas con datos."
                        )
            hojas.append(hoja)

        if gid is not None and gid.isdigit() and int(gid) not in gids.values():
            raise GoogleSheetsError(
                "GOOGLE_SHEET_TAB_NOT_FOUND",
                "La pestaña indicada en el enlace (gid) ya no existe en el Google Sheet.",
            )
        return LibroLeido(titulo=titulo, hojas=hojas, gids=gids, pestanas_sin_rejilla=sin_rejilla)

    @staticmethod
    def _fuera_de_limites(mensaje: str) -> GoogleSheetsError:
        # Lo que excede los límites se rechaza entero, igual que un XLSX (no se trunca).
        return GoogleSheetsError("INVALID_SPREADSHEET", mensaje + " Divida el libro.")


# ─────────────────────────── Hash canónico ────────────────────────────────────


def hash_de_contenido(hojas: list[Hoja], gids: Mapping[str, int]) -> str:
    """SHA-256 del contenido canonicalizado de la rejilla.

    Incluye: pestañas (nombre, gid, estado) y, por pestaña, cada fila con celdas
    (columna, tipo, texto). Excluye todo lo que no es contenido (fecha de lectura,
    título del libro, orden de las pestañas, recuentos de fórmulas), de modo que
    leer dos veces el mismo contenido da siempre el mismo hash.
    """
    canonico = [
        {
            "name": h.nombre,
            "gid": gids.get(h.nombre),
            "state": h.estado,
            "rows": [
                [numero, [[col, celda.tipo, celda.texto] for col, celda in sorted(celdas.items())]]
                for numero, celdas in sorted(h.filas.items())
            ],
        }
        for h in sorted(hojas, key=lambda x: x.nombre)
    ]
    cuerpo = json.dumps(canonico, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(cuerpo.encode("utf-8")).hexdigest()


# ─────────────────────────── Fábrica y semilla de pruebas ─────────────────────


class TransporteDeFixtures:
    """SOLO PRUEBAS. Sirve respuestas de la API de Sheets desde archivos JSON
    (`<spreadsheet_id>.json`) en lugar de llamar a Google. No hace red.

    Cada archivo: `{"status": 200, "headers": {...}, "body": {...}}`, o
    `{"raise": "timeout" | "connection"}` para simular fallos de red. Así el
    proveedor COMPLETO (validación de id, mapeo de errores, conversión de celdas)
    corre en las pruebas de punta a punta con el worker real, y solo se omite el
    salto HTTP.
    """

    def __init__(self, directorio: str) -> None:
        self._dir = Path(directorio)

    def get(
        self,
        url: str,
        params: Mapping[str, str],  # noqa: ARG002
        *,
        timeout: tuple[float, float],  # noqa: ARG002
        max_bytes: int,
    ) -> RespuestaHttp:
        validar_url_de_api(url)
        libro_id = urlparse(url).path.rsplit("/", 1)[-1]
        validar_id_de_libro(libro_id)
        archivo = self._dir / f"{libro_id}.json"
        if not archivo.is_file():
            return RespuestaHttp(404, {}, b"{}")
        definicion = json.loads(archivo.read_text(encoding="utf-8"))
        if definicion.get("raise") == "timeout":
            raise GoogleSheetsError("GOOGLE_TIMEOUT", "Google no respondió a tiempo.", reintentable=True)
        if definicion.get("raise") == "connection":
            raise GoogleSheetsError(
                "GOOGLE_UNAVAILABLE", "No se pudo conectar con Google.", reintentable=True
            )
        cuerpo = json.dumps(definicion.get("body", {})).encode("utf-8")
        if len(cuerpo) > max_bytes:
            raise GoogleSheetsError(
                "GOOGLE_RESPONSE_TOO_LARGE", "La respuesta de Google excede el tamaño máximo."
            )
        cabeceras = {str(k).lower(): str(v) for k, v in definicion.get("headers", {}).items()}
        return RespuestaHttp(int(definicion.get("status", 200)), cabeceras, cuerpo)


def crear_proveedor(
    nombre_base: str, entorno: Mapping[str, str] | None = None
) -> ProveedorGoogleSheets:
    """Proveedor de producción (cuenta de servicio) o, solo en una base `_test`
    con `GOOGLE_SHEETS_FIXTURE_DIR`, el de fixtures. En cualquier otra base esa
    variable se ignora: no hay puerta trasera hacia datos falsos."""
    env = os.environ if entorno is None else entorno
    fixtures = (env.get("GOOGLE_SHEETS_FIXTURE_DIR") or "").strip()
    if fixtures and nombre_base.endswith("_test") and env.get("ENVIRONMENT", "") != "production":
        return ProveedorGoogleSheets(TransporteDeFixtures(fixtures), email_cuenta="cuenta@servicio.test")
    cuenta = cargar_cuenta_de_servicio(env)
    return ProveedorGoogleSheets(TransporteGoogle(cuenta.credenciales), email_cuenta=cuenta.email)


__all__ = [
    "ALCANCE_SOLO_LECTURA",
    "GoogleSheetsError",
    "LibroLeido",
    "ProveedorGoogleSheets",
    "RespuestaHttp",
    "Transporte",
    "TransporteDeFixtures",
    "TransporteGoogle",
    "cargar_cuenta_de_servicio",
    "crear_proveedor",
    "hash_de_contenido",
    "validar_id_de_libro",
    "validar_url_de_api",
]
