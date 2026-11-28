# Módulo reservas

Disponibilidad, creación de citas, Mis citas y cancelación por el cliente (rebanada T3.2 a T3.5). Especificación: `docs/especificaciones/reservas.md`; algoritmo en la skill `disponibilidad-horarios`.

## Endpoints

| Método | Ruta                                      | Rol | Éxito                        | Errores                                                                                                                                                                                                                                                                                                                                 | Tarea |
| ------ | ----------------------------------------- | --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| GET    | /api/v1/barberias/:id/disponibilidad      | Pub | 200                          | NO_ENCONTRADO 404, RECURSO_INACTIVO 409, SERVICIO_NO_OFRECIDO 422, DATOS_INVALIDOS 422, AUTENTICACION_REQUERIDA 401, TOKEN_VENCIDO 401                                                                                                                                                                                                  | T3.2  |
| GET    | /api/v1/barberias/:id/disponibilidad/dias | Pub | 200                          | NO_ENCONTRADO 404, RECURSO_INACTIVO 409, SERVICIO_NO_OFRECIDO 422, DATOS_INVALIDOS 422, AUTENTICACION_REQUERIDA 401, TOKEN_VENCIDO 401                                                                                                                                                                                                  | T3.2  |
| POST   | /api/v1/citas                             | Pub | 201 (200 con clave repetida) | DATOS_INVALIDOS 422, AUTENTICACION_REQUERIDA 401, TOKEN_VENCIDO 401, NO_ENCONTRADO 404, RECURSO_INACTIVO 409, SERVICIO_NO_OFRECIDO 422, HORARIO_PASADO 422, ANTICIPACION_INSUFICIENTE 422, FECHA_DEMASIADO_LEJANA 422, FUERA_DE_HORARIO 422, BARBERO_NO_DISPONIBLE 409, HORARIO_OCUPADO 409, CRUCE_DEL_CLIENTE 409, LIMITE_DE_CITAS 409 | T3.3  |

Las dos rutas de disponibilidad viven en `rutas.ts` de este módulo y se montan en `/barberias` junto a las de `barberias` (no se pisan). Orden por solicitud: `autenticar` (401) → consulta (422) → barbería, servicio y barbero (404, 409, 422). Sin `contextoBarberia`: cualquier usuario autenticado entra, sin membresía (§2.3).

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

## POST /citas (T3.3, RES-06)

`rutasCitas` se monta en `/citas`. Orden por solicitud: `autenticar` (401) → cuerpo (422) → servicio. Cualquier usuario autenticado reserva como cliente (D-31, N2).

### Cuerpo

`esquemaCrearCita` de `src/compartido/contrato.ts` (estricto: campo extra → DATOS_INVALIDOS).

| Campo               | Regla                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `barberiaId`        | UUID                                                                                                                      |
| `servicioId`        | UUID                                                                                                                      |
| `barberoId`         | UUID del PerfilBarbero, opcional; sin él = Cualquiera disponible (CU-07 A3)                                               |
| `iniciaEn`          | ISO 8601 con hora y zona (`Z` o cualquier desfase), en un bloque de 15 minutos sin segundos (RN-10, D6); se guarda en UTC |
| `notas`             | Texto opcional, se recorta, máximo 200 y sin caracteres de control (RES-12); vacío = `null`                               |
| `claveIdempotencia` | UUID; único por cliente (D2)                                                                                              |

### Respuesta

`{ "datos": <cita> }` con `id, estado, iniciaEn, terminaEn, duracionReserva, precioReserva ("8.00"), notas, anticipoVenceEn, barberia { id, nombre, direccion, telefono }, servicio { id, nombre }, barbero { id, nombreVisible, urlFoto }, canceladaEn, motivoCancelacion, puedeCancelar` (D4). 201 al crear; 200 si la clave ya existía.

### Flujo (skill `reservas-concurrencia`, orden de §8.5)

1. Idempotencia (D2): si existe una cita del cliente con esa clave, 200 con ella sin revalidar (aunque la barbería ya no esté publicada o el cuerpo difiera).
2. Barbería, servicio y barbero con la misma validación que la disponibilidad (NO_ENCONTRADO → RECURSO_INACTIVO → SERVICIO_NO_OFRECIDO) y candidatos ordenados por id.
3. Transacción READ COMMITTED (10 s): `FOR UPDATE` de los barberos candidatos por id ascendente → cancela sus PENDIENTE con `anticipoVenceEn` < ahora ("Anticipo vencido", `canceladaPorId` nulo, auditadas como `ANTICIPO_VENCIDO`, RN-34) → `FOR UPDATE` del cliente → vuelve a buscar la clave (dos solicitudes simultáneas con la misma clave: 201 y 200) → revalida con lecturas actuales: pasado, anticipación mínima y máxima (RN-06, RN-07, D5) → jornada, pausas, bloqueos y citas con el mismo cálculo de la disponibilidad (FUERA_DE_HORARIO, BARBERO_NO_DISPONIBLE, HORARIO_OCUPADO) → cruce y límite del cliente (RN-08, RN-09; ignoran sus PENDIENTE vencidas con otros barberos) → inserta con `terminaEn`, `precioReserva` y `duracionReserva` copiados (RN-02, RN-03) → audita `CITA_CREADA` con el cliente como actor.
4. Estado inicial (RN-12): CONFIRMADA; con `anticipoActivo`, PENDIENTE con `anticipoVenceEn` = ahora + 15 min.
5. Respaldo (D-19): la violación de `ex_citas_barbero_sin_cruce` → HORARIO_OCUPADO; un P2002 del único `(clienteId, claveIdempotencia)` relee la cita y responde 200. P2028, P2034 y 40P01 repiten la transacción hasta 2 veces.

Cualquiera disponible: de los candidatos que pueden atender, el de menos citas activas (PENDIENTE vigente o CONFIRMADA) ese día local, empate por menor id. Si ninguno puede, el error del candidato que llegó más lejos en el orden de §8.5; sin candidatos, HORARIO_OCUPADO.

### Decisiones (para el PR)

- RN-09 cuenta las citas activas con `iniciaEn` ≥ ahora en esa barbería.
- Con Cualquiera disponible y ningún barbero libre, el código es el del candidato que llegó más lejos (FUERA_DE_HORARIO < BARBERO_NO_DISPONIBLE < HORARIO_OCUPADO); sin candidatos, HORARIO_OCUPADO.
- `claveIdempotencia` se guarda en minúsculas.
- Las fotos de referencia de las PENDIENTE canceladas se borrarían tras el commit; AlmacenArchivos y RES-14 aún no existen, así que hoy no hay nada que borrar.

## Pruebas

`disponibilidad.prueba.ts`: forma de la respuesta, casos límite de la skill (hueco exacto, cierre, anticipación mínima exacta, PENDIENTE vencida y vigente, bloqueos de barbero y de toda la barbería, cita a las 20:00 locales), RN-05 con horario propio y general, D5 (domingo, ventana por fecha local, Europe/Madrid), Cualquiera disponible, `/dias`, validación de la consulta, sesión, visibilidad (D7), aislamiento (SEG-02), D-33, solo lectura, RNF-01 (5 barberos y 1.000 citas en menos de 1 s) y documentación. `crear-cita.prueba.ts`: POST /citas (PO-01 a PO-05, RN-02 a RN-12, RN-34, idempotencia D2, Cualquiera disponible, D-31, SEG-02, D7, D-33, N3, orden de §8.5, cuerpo, sesión, concurrencia real y documentación). Bruno: `bruno/reservas/` (el entorno `local` trae `barberiaId`, `servicioId` y `barberoId` de las semillas).
