import { Router } from 'express';

import { autenticar, validar } from '../../compartido/middleware';
import * as controlador from './controlador';
import {
  esquemaConsultaDiasDisponibles,
  esquemaConsultaDisponibilidad,
  esquemaCrearCita,
} from './esquemas';

// Se monta en /barberias junto a rutasBarberias: sus rutas (/:id, /:id/servicios, /:id/barberos)
// no coinciden con estas.
export const rutasDisponibilidad = Router();

// RES-03, RES-04 (Pub): cualquier usuario autenticado; el cliente no necesita membresia (§2.3).
// autenticar (401) → validar la consulta (422) → barberia, servicio y barbero en el servicio (404,
// 409, 422). Sin contextoBarberia: el publico tambien entra y no se leen datos internos.
rutasDisponibilidad.get(
  '/:id/disponibilidad',
  autenticar,
  validar(esquemaConsultaDisponibilidad, 'query'),
  controlador.disponibilidad,
);
rutasDisponibilidad.get(
  '/:id/disponibilidad/dias',
  autenticar,
  validar(esquemaConsultaDiasDisponibles, 'query'),
  controlador.diasDisponibles,
);

// Se monta en /citas.
export const rutasCitas = Router();

// RES-06 (Pub, D-31): cualquier usuario autenticado reserva como cliente, sin membresia.
// autenticar (401) → validar el cuerpo (422) → servicio: idempotencia (200), barberia, servicio y
// barbero (404, 409, 422) y la transaccion con bloqueo (§8.5, skill reservas-concurrencia).
rutasCitas.post('/', autenticar, validar(esquemaCrearCita), controlador.crearCita);
