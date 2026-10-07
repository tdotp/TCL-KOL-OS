#!/usr/bin/env python3
"""Mutaciones críticas de la Fase 8 (reproducibles). Para cada garantía: rompe la regla, corre la prueba dirigida,
confirma que FALLA (mutación detectada) y restaura el archivo con `git checkout`. Se ejecuta con el árbol LIMPIO.

Uso:  DB_BASE=postgresql://tclkolos:devpassword@localhost:5432 python3 scripts/f8-mutaciones.py
Requiere `tclkolos_test` migrada y sembrada. Nota (cierre F8): 9 de 10 detectadas directamente; la #7 original
(reportarPago con una capacidad más laxa) queda enmascarada por la defensa independiente de la base
(`operaciones_exigir_rol`), por eso se sustituye por una mutación equivalente sobre el límite actor/origen
(`exigirPersonaPorUi` aceptando chat sobre packages/db/src/operational-events.ts + billing-payment.test.ts).
"""
import subprocess, os, sys
import pathlib
R=str(pathlib.Path(__file__).resolve().parent.parent)
BASE=os.environ.get('DB_BASE','postgresql://tclkolos:devpassword@localhost:5432')+'/'
def run(cmd, cwd, db='tclkolos_test'):
    env=dict(os.environ, DATABASE_URL=BASE+db, TEST_DATABASE_URL=BASE+db, PGPASSWORD='devpassword')
    p=subprocess.run(cmd, shell=True, cwd=cwd, env=env, capture_output=True, text=True, timeout=900)
    out=p.stdout+p.stderr
    return p.returncode, out
M=[
 ('1 tenant guard (envíos)', 'packages/db/src/shipments.ts', "authorizeInternalResource(actor, 'shipment:read', dueña.organization_id)", "authorizeInternalResource(actor, 'shipment:read', actor.organizationId)", 'packages/db', 'npx vitest run src/shipments.test.ts'),
 ('2 TCL financial guard (claves prohibidas)', 'packages/domain/src/tcl-projection-operacion.ts', "return NORMALIZADAS.some((p) => n.includes(p));", "return false;", 'packages/domain', 'npx vitest run src/tcl-projection-operacion.test.ts'),
 ('3 Agent PII/finance guard (secciones del agente)', 'packages/db/src/operativo-agent-view.ts', "return seccionesAEjecutar(actor, ['facturacion_pagos']);", "return seccionesAEjecutar(actor, []);", 'packages/db', 'npx vitest run src/operativo-agent-view.test.ts'),
 ('4 barter applicability', 'packages/domain/src/billing-payment.ts', "if (!context.agreementActive || context.agreementMode !== 'barter') {", "if (false) {", 'packages/domain', 'npx vitest run src/billing-payment.test.ts'),
 ('5 shipment transition guard (pending→delivered)', 'packages/domain/src/shipments.ts', "pending: ['prepared', 'cancelled'],", "pending: ['prepared', 'cancelled', 'delivered'],", 'packages/domain', 'npx vitest run src/shipments.test.ts'),
 ('7b actor/origen (exigirPersonaPorUi acepta chat)', 'packages/db/src/operational-events.ts', "  if (origen === 'chat') {\n    return err({\n      code: 'HUMAN_CONFIRMATION_REQUIRED',", "  if (false) {\n    return err({\n      code: 'HUMAN_CONFIRMATION_REQUIRED',", 'packages/db', 'npx vitest run src/billing-payment.test.ts'),
 ('8 Operativo aprueba guiones', 'packages/domain/src/permissions.ts', "    'deliverable:read',\n    // Fase 8: opera", "    'deliverable:read',\n    'script:approve',\n    // Fase 8: opera", 'packages/domain', 'npx vitest run src/permissions.test.ts'),
 ('9 idempotencia (clave de evento)', 'packages/db/src/operational-events.ts', "WHERE organization_id = $1 AND idempotency_key = $2`,", "WHERE organization_id = $1 AND idempotency_key = $2 AND false`,", 'packages/db', 'npx vitest run src/operational-events.test.ts'),
 ('10 permission check (agreement:manage)', 'packages/db/src/agreements.ts', "autorizarOAbortar(persona, 'agreement:manage', participacion.organization_id);", "void persona;", 'packages/db', 'npx vitest run src/agreements.test.ts'),
]
res=[]
for name,f,old,new,cwd,cmd in M:
    path=os.path.join(R,f)
    s=open(path).read()
    if old not in s:
        res.append((name,'NO-APLICA (patrón no encontrado)')); continue
    open(path,'w').write(s.replace(old,new))
    try:
        rc,out=run(cmd, os.path.join(R,cwd))
    finally:
        subprocess.run(['git','checkout','--',f],cwd=R)
    detect = rc!=0
    import re
    m=re.search(r'Tests\s+(.*)',out)
    res.append((name,('DETECTADA ' if detect else 'NO DETECTADA ')+(m.group(0).strip() if m else out[-120:])))
# 6: KPI immutability via SQL en clon
subprocess.run(f"psql {BASE}postgres -c 'DROP DATABASE IF EXISTS tmp_mut6_test' -c 'CREATE DATABASE tmp_mut6_test TEMPLATE tclkolos_test'",shell=True,env=dict(os.environ,PGPASSWORD='devpassword'),capture_output=True)
subprocess.run(f"psql {BASE}tmp_mut6_test -c 'DROP TRIGGER kpi_measurements_sin_update ON kpi_measurements'",shell=True,env=dict(os.environ,PGPASSWORD='devpassword'),capture_output=True)
rc,out=run('npx vitest run src/kpi-schema.test.ts', os.path.join(R,'packages/db'), db='tmp_mut6_test')
import re
m=re.search(r'Tests\s+(.*)',out)
res.append(('6 KPI immutability (trigger sin UPDATE, en clon)',('DETECTADA ' if rc!=0 else 'NO DETECTADA ')+(m.group(0).strip() if m else out[-120:])))
subprocess.run(f"psql {BASE}postgres -c 'DROP DATABASE tmp_mut6_test'",shell=True,env=dict(os.environ,PGPASSWORD='devpassword'),capture_output=True)
for n,r in res: print(n,'=>',r)
