# Módulo reservas

Disponibilidad, creación de citas, Mis citas y cancelación por el cliente (rebanada T3.2 a T3.5). Especificación: `docs/especificaciones/reservas.md`; algoritmo en la skill `disponibilidad-horarios`.

## Endpoints

| Método | Ruta                                      | Rol | Éxito | Errores                                                                                                                                | Tarea |
| ------ | ----------------------------------------- | --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| GET    | /api/v1/barberias/:id/disponibilidad      | Pub | 200   | NO_ENCONTRADO 404, RECURSO_INACTIVO 409, SERVICIO_NO_OFRECIDO 422, DATOS_INVALIDOS 422, AUTENTICACION_REQUERIDA 401, TOKEN_VENCIDO 401 | T3.2  |
| GET    | /api/v1/barberias/:id/disponibilidad/dias | Pub | 200   | NO_ENCONTRADO 404, RECURSO_INACTIVO 409, SERVICIO_NO_OFRECIDO 422, DATOS_INVALIDOS 422, AUTENTICACION_REQUERIDA 401, TOKEN_VENCIDO 401 | T3.2  |

Las dos rutas viven en `rutas.ts` de este módulo y se montan en `/barberias` junto a las de `barberias` (no se pisan). Orden por solicitud: `autenticar` (401) → consulta (422) → barbería, servicio y barbero (404, 409, 422). Sin `contextoBarberia`: cualquier usuario autenticado entra, sin membresía (§2.3).

### Consulta

Esquemas `esquemaConsultaDisponibilidad` y `esquemaConsultaDiasDisponibles` de `src/compartido/contrato.ts` (la app usa los mismos). Sin parámetros extra.

| Parámetro    | Regla                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------- |
| `servicioId` | UUID, obligatorio                                                                            |
| `barberoId`  | UUID del PerfilBarbero, opcional; sin él = Cualquiera disponible (RES-02). Vacío es inválido |
| `fecha`      | Solo `/disponibilidad`: fecha local `AAAA-MM-DD` que exista (2026-02-30 es inválida)         |
| `desde`      | Solo `/dias`: como `fecha`                                                                   |
| `hasta`      | Solo `/dias`: como `fecha`, no anterior a `desde`, rango de 1 a 31 días inclusive            |

### Respuestas

- `GET /disponibilidad` → `{ "datos": { "fecha": "2026-12-02", "horarios": [{ "iniciaEn": "2026-12-02T14:00:00.000Z" }] } }`: inicios ascendentes en ISO UTC, sin repetir y sin barbero (D1).
- `GET /disponibilidad/dias` → `{ "datos": [{ "fecha": "2026-12-01", "disponible": true }] }`: un elemento por día del rango pedido, en orden.
- La app muestra las horas en la `zonaHoraria` que trae GET /barberias/:id (T3.2).

### Cálculo (skill `disponibilidad-horarios`, §8.6)

Por barbero y fecha local de la barbería (`Barberia.zonaHoraria`, con Luxon):

1. Horario propio del barbero recortado al general de la barbería (RN-05). Sin uno de los dos ese día, no trabaja (D-31, N1). `diaSemana` 0 = domingo (D5).
2. Se restan las pausas de ambos horarios, los Bloqueos suyos y los de toda la barbería (RN-26).
3. Se restan sus citas PENDIENTE y CONFIRMADA, semiabiertas `[iniciaEn, terminaEn)` (RN-04). Una PENDIENTE con `anticipoVenceEn` anterior a ahora no ocupa (RN-34, §4.7).
4. Inicios en horas de reloj locales (:00, :15, :30, :45, D5) donde cabe `duracionMinutos` completa (RN-10).
5. Ninguno antes de ahora + `minutosMinAnticipacion` (RN-06; el inicio exacto se ofrece).
6. Solo fechas de hoy local a hoy local + `diasMaxAnticipacion` (RN-07, D5); fuera de esa ventana o en el pasado, lista vacía o `disponible` falso.

`/dias` usa el mismo cálculo y se detiene en el primer inicio de cada día.

### Candidatos y errores

- Con `barberoId`: solo ese barbero. Sin él: los barberos de la barbería con membresía ACTIVO, Usuario activo y el servicio asignado (`ServicioBarbero`, RN-23, D-33); se unen sus inicios sin repetir. Sin candidatos: 200 con lista vacía.
- Orden de errores: NO_ENCONTRADO → RECURSO_INACTIVO → SERVICIO_NO_OFRECIDO.
  - NO_ENCONTRADO 404: barbería inexistente, que no es UUID, inactiva o no publicada (también para sus miembros, D7); servicio o barbero inexistente o de otra barbería (SEG-02); barbero con Usuario inactivo (D-33) o con membresía INVITADO (nunca fue público), como un barbero ajeno.
  - RECURSO_INACTIVO 409: servicio inactivo (con y sin `barberoId`); barbero de la barbería con membresía INACTIVO y `barberoId` explícito.
  - SERVICIO_NO_OFRECIDO 422: barbero de la barbería que no ofrece el servicio (RN-23).

### Rendimiento (RNF-01)

Seis consultas como máximo, sin importar días ni barberos: barbería, servicio y barbero (o candidatos) en paralelo, y luego horarios, bloqueos y citas del rango de todos los candidatos (`perfilBarberoId: { in: candidatos }`) en paralelo. Todo lo demás se calcula en memoria. Las citas se leen con `iniciaEn` entre el inicio del rango menos un día y su fin (ninguna cita dura más de un día), para usar el índice `(perfilBarberoId, iniciaEn, estado)`. Si el rango cae entero fuera de la ventana o no hay candidatos, no se leen horarios, bloqueos ni citas.

### Decisiones (para el PR)

- Membresía INACTIVO de la misma barbería con `barberoId` explícito → RECURSO_INACTIVO; INVITADO → NO_ENCONTRADO (revisor-seguridad: un invitado nunca fue público). Sin `barberoId`, ninguno de los dos cuenta.
- Usuario inactivo (D-33) o barbero de otra barbería → NO_ENCONTRADO.
- Orden: NO_ENCONTRADO → RECURSO_INACTIVO → SERVICIO_NO_OFRECIDO.
- Estos GET solo leen: una PENDIENTE vencida (RN-34) cuenta como libre sin modificarla; la cancelan el proceso programado y POST /citas.
- Cualquiera disponible = unión sin repetir de los inicios de los candidatos.
- Una PENDIENTE sin `anticipoVenceEn` (no debería existir) ocupa el horario.
- Zona horaria inválida en la base (`IANAZone.isValidZone`): 500 INTERNO (dato corrupto, el detalle va al log).
- El bucle de fechas se acota también por `MAXIMO_DIAS_DISPONIBILIDAD` (31), además de la validación de la consulta.
- Librería nueva `luxon` (con `@types/luxon`): la fijan la skill `disponibilidad-horarios` y `arquitectura-api` para horarios locales y zonas IANA.

## Pruebas

`disponibilidad.prueba.ts`: forma de la respuesta, casos límite de la skill (hueco exacto, cierre, anticipación mínima exacta, PENDIENTE vencida y vigente, bloqueos de barbero y de toda la barbería, cita a las 20:00 locales), RN-05 con horario propio y general, D5 (domingo, ventana por fecha local, Europe/Madrid), Cualquiera disponible, `/dias`, validación de la consulta, sesión, visibilidad (D7), aislamiento (SEG-02), D-33, solo lectura, RNF-01 (5 barberos y 1.000 citas en menos de 1 s) y documentación. Bruno: `bruno/reservas/` (el entorno `local` trae `barberiaId`, `servicioId` y `barberoId` de las semillas).
