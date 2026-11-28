import { Router } from 'express';

import { autenticar, validar } from '../../compartido/middleware';
import * as controlador from './controlador';
import { esquemaConsultaDiasDisponibles, esquemaConsultaDisponibilidad } from './esquemas';

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
