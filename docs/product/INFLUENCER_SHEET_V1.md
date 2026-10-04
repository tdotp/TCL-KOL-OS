# TCL KOL OS · Sheet de influencers — esquema V1

Especificación para quien prepara el Google Sheet. Es el contrato que el sistema valida por máquina
(`packages/domain/src/influencer-sheet.ts`); los ejemplos de `fixtures/influencer-sheet/` se prueban contra el
validador real, así que esta página no puede divergir del código.

> El Sheet es una **fuente operativa estructurada**: el sistema no adivina layouts. Si no cumple este contrato, se
> informa exactamente qué falla y **no se importa nada**.

## 1. Cómo se conecta

1. En el chat (Fase 6) o desde el servicio, se registra el enlace del Sheet en la campaña
   (`registerLinkedSource`). Registrar **no** lee el Sheet.
2. El Sheet debe estar **compartido como lector** con la cuenta de servicio de TCL KOL OS (`…@….iam.gserviceaccount.com`;
   el correo exacto se le indica en el mensaje cuando falta el acceso). La integración es de **solo lectura**: no
   puede editar el Sheet.
3. Se pide la sincronización (`syncGoogleSheetSource`): el sistema guarda una **lectura inmutable** (snapshot).
4. Se prepara el plan de importación sobre ese snapshot; una persona lo revisa, lo aplica y resuelve lo ambiguo.

Si el enlace apunta a una pestaña concreta (`#gid=…`), se valida esa pestaña. Si no, se usa la única pestaña que lleve
el marcador (si hay dos o más, es un error: deje una sola o use el enlace de la pestaña).

## 2. Estructura de la pestaña

| Celda / fila | Contenido |
|---|---|
| **A1** | El marcador **`TCL_KOL_OS_INFLUENCERS_V1`** (señal inequívoca de esquema y versión). No distingue mayúsculas. Nada más en la fila 1 (otras celdas se ignoran con una advertencia). |
| **Fila 2** | Las cabeceras de columna (sección 3). |
| **Fila 3 en adelante** | Los datos. Las filas totalmente vacías se ignoran. |

El nombre de la pestaña es libre: se identifica por el marcador, no por el nombre.

**Una fila = una cuenta de una persona.** Una persona con varias cuentas ocupa varias filas con la **misma**
`clave_influencer`. (Se eligió este modelo porque es el menos ambiguo: cada cuenta es una fila con su propia
plataforma, handle, producto y condiciones; agregar una cuenta es agregar una fila, sin columnas numeradas.)

## 3. Columnas

Las cabeceras se normalizan **solo** así: minúsculas, y espacios o guiones pasan a `_` (`Clave Influencer` y
`clave-influencer` son `clave_influencer`). **No hay alias** (`id`, `name`… no valen).

### Obligatorias (si falta una, el Sheet es inválido)

| Columna | Qué es | Reglas |
|---|---|---|
| `clave_influencer` | Identificador **estable de la persona dentro de este Sheet** (`INF-001`, `INF-002`…). | Letras, números, `.`, `_`, `-`; hasta 64 caracteres; no distingue mayúsculas (`inf-001` = `INF-001`). Una clave = una persona; **nunca cambie ni reutilice** una clave. No es el id global del Influencer. |
| `nombre` | Nombre de la persona. | Hasta 200 caracteres. Todas las filas de una misma clave deben tener el **mismo** nombre. **No identifica**: dos personas pueden llamarse igual (cada una con su clave). |
| `plataforma` | Plataforma de la cuenta. | `instagram`, `tiktok`, `youtube`, `x`, `facebook`, `twitch` (sin distinguir mayúsculas). |
| `handle` | Usuario de la cuenta. | Letras, números, `.`, `_`, `-`; se acepta un `@` inicial. **Sin URLs, espacios ni `/`.** `valentina.rojas` y `valentinarojas` son cuentas distintas. |

### Opcional del núcleo (la Fase 5 lo materializa)

| Columna | Qué es | Reglas |
|---|---|---|
| `producto` | Producto que trabaja la persona. | Se compara con el **modelo** de los productos **de esta campaña**, sin distinguir mayúsculas ni espacios repetidos (`p80 PRO` = `P80 Pro`; `P80` ≠ `P80 Pro`). Sin similitud. Una persona puede tener varios (varias filas). |

### Columnas futuras (se **validan y se conservan**; todavía no se ejecutan)

| Columna | Validación |
|---|---|
| `entregables` | Texto libre. |
| `tipo_acuerdo` | `fee`, `canje` o `mixto`. |
| `fee` | Número. |
| `canje` | Texto libre. |
| `fecha_inicio`, `fecha_fin` | Fecha `AAAA-MM-DD`; `fecha_fin` no anterior a `fecha_inicio`. |
| `kpi_objetivo` | Texto libre. |
| `condiciones` | Texto libre. |

Estos valores quedan en el snapshot (con su hoja y rango) hasta que existan Acuerdos, Entregables y KPIs
(Fases 7–8). **No** se crean esas entidades ni se vuelcan a `CampaignInfluencer`.

### Columnas desconocidas

Se conservan en el snapshot, no se interpretan y se informan como **advertencia** (`HEADER_UNKNOWN`). Nunca se
descartan en silencio.

## 4. Qué se valida (y qué pasa si falla)

**Errores del Sheet** — el Sheet entero es inválido y **no se importa nada** (el snapshot sigue siendo una lectura
válida; solo el negocio dice «no»): marcador ausente, versión distinta de V1, fila de cabeceras vacía, cabecera
obligatoria ausente, cabecera repetida, pestaña (`gid`) inexistente, dos pestañas con marcador.

**Errores de un registro** — solo ese registro queda inválido (los demás siguen): clave ausente o inválida, nombre
vacío, plataforma ausente o no soportada, handle inválido, celda con error de la hoja (`#REF!`…), nombres distintos
bajo una misma clave, una cuenta repetida bajo la misma clave, **la misma cuenta bajo dos claves** (se invalidan
ambas: no se adivina quién es), `tipo_acuerdo`/`fee`/fechas inválidos.

## 5. Qué hace el sistema con cada registro

Orden de resolución: **binding previo de la fuente → coincidencia exacta de cuenta → crear → decisión humana.**

| Situación | Resultado |
|---|---|
| La clave ya estaba vinculada | Se mantiene esa persona (aunque cambien nombre o cuentas). El nombre distinto se **informa**, no se pisa. |
| Una cuenta (plataforma + handle) ya existe | Se reutiliza esa persona (también si trabajó en otra campaña). |
| Ninguna cuenta existe | Se crea la persona, sus cuentas y su participación. |
| Cuentas del mismo registro de **personas distintas** | **Ambiguo**: no se muta; decide una persona. |
| La cuenta es de otra persona / la persona es otra clave | **Conflicto**: no se muta. |
| Cuenta nueva en una plataforma donde ya tiene otra | **Cambio de cuenta**: decide una persona (se añade, nunca se reemplaza). |
| Participación retirada | No se reactiva sola. |
| Producto sin resolver / ambiguo | La persona se crea; el producto queda pendiente de elección. |
| Producto distinto del ya asignado | **Cambio de producto**: nunca reemplaza; decide una persona. |
| La clave desaparece del Sheet | **Para revisión** (`missing_from_source`). **No** se retira a nadie ni se desasigna nada. |

La campaña debe estar **activa** para materializar: en una campaña archivada o cancelada se puede leer, comparar y
planear, pero no aplicar ni resolver.

## 6. Ejemplos

Válidos y no válidos, listos para importar en Google Sheets, en [`fixtures/influencer-sheet`](../../fixtures/influencer-sheet/README.md).

Mínimo válido:

```
A1: TCL_KOL_OS_INFLUENCERS_V1
2 : clave_influencer | nombre          | plataforma | handle           | producto
3 : INF-001          | Valentina Rojas | instagram  | @valentina.rojas | P80
4 : INF-002          | Juan Pérez      | tiktok     | juanperez        | P80 Pro
```

Una persona con dos cuentas (misma clave y mismo nombre):

```
3 : INF-001 | Valentina Rojas | instagram | @valentina.rojas | P80
4 : INF-001 | Valentina Rojas | tiktok    | valerojas        | P80
```

Dos personas homónimas (claves distintas → dos personas, nunca se fusionan por el nombre):

```
5 : INF-003 | María García | instagram | maria.g       |
6 : INF-004 | María García | instagram | mariagarcia2  |
```

No válidos: ver `invalido-*.csv` (sin marcador, versión V2, falta `handle`, plataforma desconocida, handle con
espacio, acuerdo inventado, fee en palabras, cuenta duplicada entre claves, fila sin clave).

## 7. Compatibilidad

El esquema está **versionado** (`_V1`). Hoy una versión distinta de V1 se rechaza explícitamente
(`MARKER_UNSUPPORTED_VERSION`): un cambio incompatible futuro se declararía como `_V2` y se decidiría entonces cómo
conviven; no hay reinterpretación silenciosa entre versiones.
