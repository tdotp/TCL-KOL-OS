# Influencer + CampaignInfluencer (V2 · Fase 3)

Base: `fe13cf6`. Decisión: DEC-044. Migraciones: `015_influencers.sql` (identidad y cuentas) y `016_campaign_influencers.sql` (participación y producto asignado).

## 1. Identidad ≠ participación

```
Organización (agencia)
└── Influencer                       quién es (identidad estable)
    └── InfluencerAccount            sus cuentas por plataforma (identidad fuerte)

Campaña
└── CampaignInfluencer ──► Influencer      qué significa en ESTA campaña (punto de anclaje)
    └── campaign_influencer_products ──► campaign_products    qué producto(s) de la campaña trabaja
```

`Influencer` no guarda nada de una campaña (fee, producto, fechas, estado operativo, guiones). `CampaignInfluencer` solo guarda la relación y su estado; acuerdo, entregables, guiones, operación y KPIs colgarán de él en fases posteriores, cada uno como entidad propia. No hay columnas ni JSON anticipados.

## 2. Cuentas y handle

Una persona puede tener varias cuentas (`instagram`, `tiktok`, `youtube`, `x`, `facebook`, `twitch`; enum `social_platform`, ampliable con una migración de una línea). Una cuenta no «se muda» a otro influencer ni cambia de plataforma (trigger); unir identidades es una decisión explícita de la Fase 5.

**Regla única de normalización** (`normalizeHandle`, `packages/domain/src/influencers.ts`):
1. Unicode NFKC. 2. Recorte y un `@` inicial fuera. 3. Solo letras, números, `.`, `_`, `-` (sin espacios, `@` interno, `/`, caracteres invisibles; ni URLs). 4. Minúsculas, salvo que la plataforma distinga mayúsculas (`POLITICA_DE_HANDLE`; hoy ninguna).

No se tocan los signos: `valentina.rojas` ≠ `valentinarojas`. No hay fuzzy ni heurísticas. Se guarda `handle` (como se escribió, para mostrar) y `normalized_handle` (clave). La base solo **vigila** que llegue normalizada (sin `@`/espacios/`/`, en minúsculas); la regla vive en un solo sitio.

## 3. Unicidad

| Qué | Cómo |
|---|---|
| Misma cuenta social, una vez por organización | `UNIQUE (organization_id, platform, normalized_handle)` |
| Mismo handle en otra plataforma / otra organización | Permitido (otra identidad) |
| Mismo influencer, una vez por campaña | `UNIQUE (campaign_id, influencer_id)` |
| Mismo influencer en campañas distintas | Permitido (una fila por campaña) |
| Dos personas con el mismo nombre | Permitido: `display_name` no es clave |
| Mismo producto asignado dos veces | `UNIQUE (campaign_influencer_id, campaign_product_id)` |

Cada regla se comprueba antes en la aplicación (error claro, con el id existente en `details`) y la respalda la base (carreras: 23505 → `RESOURCE_CONFLICT`). No se deduplica por nombre, correo ni IA.

## 4. Aislamiento (multitenancy)

`Influencer` pertenece a la organización (agencia) que lo gestiona. `influencer_accounts`, `campaign_influencers` llevan `organization_id` y **claves foráneas compuestas** `(id, organization_id)` hacia `influencers` y `campaigns`: la base impide cuentas, participaciones o asignaciones que crucen organizaciones. En la aplicación, `authorizeInternalResource` devuelve `RESOURCE_NOT_FOUND` para recurso ajeno (no revela que existe) y `FORBIDDEN_ROLE` para un rol sin capacidad. El cliente nunca accede: la visibilidad de la campaña **no** se hereda a estos datos.

## 5. Producto asignado

`campaign_influencer_products` referencia `campaign_products` por `(campaign_product_id, campaign_id)` y la participación por `(campaign_influencer_id, campaign_id)`: es **imposible** asignar un producto de otra campaña (aunque sea el mismo producto del catálogo), también por SQL directo. Varios productos por influencer; sin duplicados; la asignación no se edita (se asigna o se desasigna). La lectura (`products`) expone marca/modelo/categoría/rol, **no** el reparto de presupuesto de la campaña.

## 6. Estado y borrado

`campaign_influencers.status`: `activo | retirado` (`retired_at` coherente por CHECK). Existe porque retirar a alguien de una campaña no debe destruir su historia (y lo que cuelgue después). Retirado: no admite cambios de producto; asociar de nuevo falla indicando la fila existente; reactivar es una acción explícita. Influencers, cuentas y participaciones **no admiten DELETE** (trigger; único bypass: bases `_test`, migración 010) y todas las FK son `RESTRICT`. Desasignar un producto sí borra el vínculo (queda en `audit_events`). El influencer no tiene estado propio: no hay necesidad todavía.

## 7. Permisos

| Rol | influencer | campaign_influencer |
|---|---|---|
| admin · director · consultor | read + manage | read + manage |
| operativo | read | read (con productos asignados) |
| cliente · analista · legal | — | — |
| sistema | no muta (solo personas) | no muta |

Leer el detalle de una participación exige ambas lecturas. No se añadieron permisos financieros ni de cliente. El test exacto del Operativo se actualizó porque su contrato cambió legítimamente (+2 lecturas).

## 8. Auditoría y origen

Se reutiliza `audit_events` (misma transacción que la mutación): `influencer.create|update`, `influencer_account.add|update`, `campaign_influencer.associate|retire|reactivate|product_assign|product_unassign`. Origen `ui` por defecto; `correlation` disponible. No se simuló ningún evento `chat`. No hay columna `source` en las entidades: `origin` + actor ya responden quién y por qué canal; la procedencia de un import (Fase 5) vivirá en el propio import.

## 9. Casos de uso (`packages/db`)

`crearInfluencer` (con cuentas opcionales, atómico), `actualizarInfluencer`, `obtenerInfluencer`, `listarInfluencers`, `buscarInfluencerPorCuenta` (coincidencia exacta por identidad fuerte, el contrato de la Fase 5), `agregarCuenta`, `actualizarCuenta`, `asociarInfluencerACampana`, `retirarInfluencerDeCampana`, `reactivarInfluencerEnCampana`, `obtenerCampaignInfluencer`, `listarInfluencersDeCampana`, `asociarProductoAInfluencer`, `desasociarProducto`. Sin endpoints ni UI.

## 10. Puntos de extensión y deuda

- Fases 5–8 cuelgan de `campaign_influencers.id` (acuerdo, entregables, guiones, operación, KPIs).
- `created_by` es `NOT NULL`: una importación del sistema (Fase 5) necesitará un actor humano o una migración que lo relaje.
- No se bloquea asociar/asignar sobre una campaña `archivada`/`cancelada`; no se decidió.
- No hay baja de cuentas ni fusión de identidades (Fase 5).
- El feed de actividad del Brief (`listBriefActivity`) no incluye estos eventos.
- `analista`/`legal` sin acceso (decisión conservadora; revisar con el catálogo de roles en la limpieza).
