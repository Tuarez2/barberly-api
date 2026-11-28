import type { Request, Response } from 'express';

import { ErrorNegocio } from '../../compartido/errores';
import type {
  ConsultaDiasDisponibles,
  ConsultaDisponibilidad,
  EntradaCrearCita,
  RespuestaCita,
  RespuestaDiasDisponibles,
  RespuestaDisponibilidad,
} from './esquemas';
import * as servicio from './servicio';

// Express tipa :id como string; si faltara, el servicio responde NO_ENCONTRADO.
function idRuta(req: Request): string {
  return typeof req.params.id === 'string' ? req.params.id : '';
}

export async function disponibilidad(
  req: Request,
  res: Response<RespuestaDisponibilidad>,
): Promise<void> {
  // autenticar va antes en la ruta; esto solo protege si alguien la quita.
  if (!req.usuario) throw new ErrorNegocio('AUTENTICACION_REQUERIDA', 401, 'Debes iniciar sesión');
  const datos = await servicio.disponibilidad(idRuta(req), req.validado as ConsultaDisponibilidad);
  res.status(200).json({ datos });
}

export async function diasDisponibles(
  req: Request,
  res: Response<RespuestaDiasDisponibles>,
): Promise<void> {
  if (!req.usuario) throw new ErrorNegocio('AUTENTICACION_REQUERIDA', 401, 'Debes iniciar sesión');
  const datos = await servicio.diasDisponibles(
    idRuta(req),
    req.validado as ConsultaDiasDisponibles,
  );
  res.status(200).json({ datos });
}

// RES-06: 201 si se creo; 200 si la claveIdempotencia ya existia para este cliente (D2).
export async function crearCita(req: Request, res: Response<RespuestaCita>): Promise<void> {
  if (!req.usuario) throw new ErrorNegocio('AUTENTICACION_REQUERIDA', 401, 'Debes iniciar sesión');
  const { cita, creada } = await servicio.crearCita(
    req.usuario.id,
    req.validado as EntradaCrearCita,
  );
  res.status(creada ? 201 : 200).json({ datos: cita });
}
