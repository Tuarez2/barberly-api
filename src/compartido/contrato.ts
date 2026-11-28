// Contrato comun con barberly-movil y barberly-panel (D-11): cada uno guarda una copia de este archivo.
// Si cambia, se copia en la misma funcionalidad. Sin logica de negocio.
import { z } from 'zod';

export const esquemaUuid = z.uuid();

// DERCAS §10.1: por defecto 1 y 10, maximo 50.
export const esquemaPaginacion = z
  .object({
    pagina: z.coerce.number().int().min(1).default(1),
    limite: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export type Paginacion = z.infer<typeof esquemaPaginacion>;

export const ROLES_MEMBRESIA = ['PROPIETARIO', 'BARBERO'] as const;
export type RolMembresia = (typeof ROLES_MEMBRESIA)[number];

export const ESTADOS_MEMBRESIA = ['INVITADO', 'ACTIVO', 'INACTIVO'] as const;
export type EstadoMembresia = (typeof ESTADOS_MEMBRESIA)[number];

// Autenticacion: registro (§11.4, D-14). Mensajes en español: la app los muestra junto al campo.
const BYTES_MAXIMOS_CLAVE = 72; // limite de bcrypt

export function normalizarTelefono(telefono: string): string {
  return /^09\d{8}$/.test(telefono) ? `+593${telefono.slice(1)}` : telefono;
}

export const esquemaNombre = z
  .string({ error: 'El nombre es obligatorio' })
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(80, 'El nombre debe tener como máximo 80 caracteres')
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'El nombre no puede tener caracteres de control');

export const esquemaCorreo = z
  .string({ error: 'El correo es obligatorio' })
  .trim()
  .toLowerCase()
  .max(120, 'El correo debe tener como máximo 120 caracteres')
  .pipe(z.email('Escribe un correo válido'));

export const esquemaTelefono = z
  .string({ error: 'El teléfono es obligatorio' })
  .transform((telefono) => telefono.replace(/[\s\-.()]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'El teléfono debe tener de 7 a 15 dígitos'))
  .transform(normalizarTelefono);

export const esquemaClave = z
  .string({ error: 'La contraseña es obligatoria' })
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(72, 'La contraseña debe tener como máximo 72 caracteres')
  .regex(/\p{L}/u, 'La contraseña debe tener al menos una letra')
  .regex(/\d/, 'La contraseña debe tener al menos un número')
  .refine(
    (clave) => new TextEncoder().encode(clave).length <= BYTES_MAXIMOS_CLAVE,
    'La contraseña es demasiado larga',
  );

export const esquemaDispositivo = z
  .string()
  .trim()
  .min(1, 'El dispositivo no puede estar vacío')
  .max(100, 'El dispositivo debe tener como máximo 100 caracteres')
  .regex(/^\P{Cc}*$/u, 'El dispositivo no puede tener caracteres de control');

export const esquemaRegistro = z.strictObject(
  {
    nombre: esquemaNombre,
    correo: esquemaCorreo,
    telefono: esquemaTelefono,
    clave: esquemaClave,
    dispositivo: esquemaDispositivo.optional(),
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía los datos del registro',
  },
);

export type EntradaRegistro = z.infer<typeof esquemaRegistro>;

// D-16: sin las reglas del registro; solo no vacia y de maximo 72 caracteres.
export const esquemaInicioSesion = z.strictObject(
  {
    correo: esquemaCorreo,
    clave: z
      .string({ error: 'La contraseña es obligatoria' })
      .min(1, 'Escribe tu contraseña')
      .max(72, 'La contraseña debe tener como máximo 72 caracteres'),
    dispositivo: esquemaDispositivo.optional(),
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía tu correo y tu contraseña',
  },
);

export type EntradaInicioSesion = z.infer<typeof esquemaInicioSesion>;

// AUT-07 y D-01: recuperar la contraseña con un codigo de 6 digitos enviado por correo.
export const esquemaRecuperarClave = z.strictObject(
  { correo: esquemaCorreo },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía tu correo',
  },
);

export type EntradaRecuperarClave = z.infer<typeof esquemaRecuperarClave>;

export const esquemaRestablecerClave = z.strictObject(
  {
    correo: esquemaCorreo,
    codigo: z
      .string({ error: 'El código es obligatorio' })
      .regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
    claveNueva: esquemaClave,
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía tu correo, el código y la contraseña nueva',
  },
);

export type EntradaRestablecerClave = z.infer<typeof esquemaRestablecerClave>;

// Lo devuelve recuperar-clave: el mismo texto exista o no el correo.
export interface DatosRecuperarClave {
  mensaje: string;
}

// AUT-05: nombre y telefono con las reglas del registro; el correo no cambia en el MVP.
export const esquemaEdicionPerfil = z
  .strictObject(
    {
      nombre: esquemaNombre.optional(),
      telefono: esquemaTelefono.optional(),
    },
    {
      error: (problema) =>
        problema.code === 'unrecognized_keys'
          ? `Campos no permitidos: ${problema.keys.join(', ')}`
          : 'Envía el nombre o el teléfono',
    },
  )
  .refine(
    (perfil) => perfil.nombre !== undefined || perfil.telefono !== undefined,
    'Envía el nombre o el teléfono',
  );

export type EntradaEdicionPerfil = z.infer<typeof esquemaEdicionPerfil>;

// AUT-06 y D-16: la actual solo no vacia y de maximo 72; la nueva con las reglas del registro.
export const esquemaCambioClave = z.strictObject(
  {
    claveActual: z
      .string({ error: 'La contraseña actual es obligatoria' })
      .min(1, 'Escribe tu contraseña actual')
      .max(72, 'La contraseña actual debe tener como máximo 72 caracteres'),
    claveNueva: esquemaClave,
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía tu contraseña actual y la nueva',
  },
);

export type EntradaCambioClave = z.infer<typeof esquemaCambioClave>;

// D-17: renovar y cerrar sesion reciben solo el token de renovacion (43 caracteres en base64url).
export const esquemaTokenSesion = z.strictObject(
  {
    tokenRenovacion: z
      .string({ error: 'El token de renovación es obligatorio' })
      .min(1, 'El token de renovación es obligatorio')
      .max(128, 'El token de renovación no es válido'),
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía el token de renovación',
  },
);

export type EntradaTokenSesion = z.infer<typeof esquemaTokenSesion>;

export interface UsuarioSesion {
  id: string;
  nombre: string;
  correo: string;
  telefono: string;
}

// D-14: lo devuelven el registro y el inicio de sesion (D-16).
export interface DatosSesion {
  usuario: UsuarioSesion;
  tokenAcceso: string;
  tokenRenovacion: string;
}

// D-18: lo devuelve GET /usuarios/yo. Fechas en ISO 8601 UTC.
export interface MembresiaUsuario {
  id: string;
  rol: RolMembresia;
  barberoId: string | null; // PerfilBarbero, solo si rol es BARBERO (§10.1)
  barberia: { id: string; nombre: string };
}

export interface PerfilUsuario extends UsuarioSesion {
  consentimientoIaEn: string | null;
  membresias: MembresiaUsuario[];
}

// D-17: lo devuelve renovar.
export interface DatosRenovacion {
  tokenAcceso: string;
  tokenRenovacion: string;
}

// Registrar barberia, POST /barberias (AUT-10, D-13). Reglas y zona horaria quedan por defecto.
// Misma regla que el nombre de Usuario: sin caracteres de control ni de formato (U+202E, U+200B...).
const SIN_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;

export const esquemaRegistroBarberia = z.strictObject(
  {
    nombre: z
      .string({ error: 'El nombre es obligatorio' })
      .trim()
      .min(3, 'El nombre debe tener al menos 3 caracteres')
      .max(80, 'El nombre debe tener como máximo 80 caracteres')
      .regex(SIN_CONTROL, 'El nombre no puede tener caracteres de control'),
    direccion: z
      .string({ error: 'La dirección es obligatoria' })
      .trim()
      .min(3, 'La dirección debe tener al menos 3 caracteres')
      .max(200, 'La dirección debe tener como máximo 200 caracteres')
      .regex(SIN_CONTROL, 'La dirección no puede tener caracteres de control'),
    telefono: esquemaTelefono,
    descripcion: z
      .string({ error: 'La descripción debe ser texto' })
      .trim()
      .max(500, 'La descripción debe tener como máximo 500 caracteres')
      .regex(SIN_CONTROL, 'La descripción no puede tener caracteres de control')
      .transform((descripcion) => (descripcion === '' ? null : descripcion))
      .optional(),
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Envía los datos de la barbería',
  },
);

export type EntradaRegistroBarberia = z.infer<typeof esquemaRegistroBarberia>;

// Lo devuelve POST /barberias: la barberia nace sin publicar (D-07) con su membresia PROPIETARIO.
export interface BarberiaRegistrada {
  id: string;
  nombre: string;
  descripcion: string | null;
  direccion: string;
  telefono: string;
  publicada: boolean;
  activo: boolean;
  membresia: { id: string; rol: RolMembresia; estado: EstadoMembresia };
}

export interface MetaPaginacion {
  pagina: number;
  limite: number;
  total: number;
}

export interface RespuestaExito<T> {
  datos: T;
  meta?: MetaPaginacion;
}

export interface RespuestaError {
  error: {
    codigo: string;
    mensaje: string;
    detalles?: unknown;
  };
}

// Listado publico, GET /barberias (BUS-01 a BUS-04, D-07). q y servicio: 1 a 80 caracteres tras
// recortar; la API los busca sin tildes ni mayusculas y con % y _ literales.
const esquemaTextoBusqueda = (campo: string) =>
  z
    .string({ error: `${campo} debe ser texto` })
    .trim()
    .min(1, `${campo} no puede estar vacío`)
    .max(80, `${campo} debe tener como máximo 80 caracteres`)
    .regex(SIN_CONTROL, `${campo} no puede tener caracteres de control`);

export const esquemaConsultaBarberias = z.strictObject(
  {
    q: esquemaTextoBusqueda('La búsqueda').optional(),
    servicio: esquemaTextoBusqueda('El servicio').optional(),
    // true: solo las abiertas ahora; false o ausente: todas.
    abierta: z
      .enum(['true', 'false'], { error: 'abierta debe ser true o false' })
      .transform((valor) => valor === 'true')
      .optional(),
    orden: z.enum(['nombre'], { error: 'Solo se puede ordenar por nombre' }).default('nombre'),
    ...esquemaPaginacion.shape,
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Parámetros no permitidos: ${problema.keys.join(', ')}`
        : 'Revisa los filtros de la búsqueda',
  },
);

export type ConsultaBarberias = z.infer<typeof esquemaConsultaBarberias>;

export const esquemaBarberiaListada = z.object({
  id: z.uuid(),
  nombre: z.string(),
  direccion: z.string(),
  urlPortada: z.string().nullable(),
  abierta: z.boolean(),
});

export type BarberiaListada = z.infer<typeof esquemaBarberiaListada>;

export const esquemaRespuestaListadoBarberias = z.object({
  datos: z.array(esquemaBarberiaListada),
  meta: z.object({
    pagina: z.number().int(),
    limite: z.number().int(),
    total: z.number().int(),
  }),
});

export type RespuestaListadoBarberias = z.infer<typeof esquemaRespuestaListadoBarberias>;

// Detalle publico, GET /barberias/:id (BUS-05, BUS-08, D-32). Horas locales "HH:mm" de la barberia;
// diaSemana 0 = domingo a 6 = sabado; los dias sin fila no atienden. Instantes en ISO 8601 UTC.
const esquemaHoraLocal = z.string().regex(/^\d{2}:\d{2}$/);

export const esquemaHorarioBarberia = z.object({
  diaSemana: z.number().int().min(0).max(6),
  horaApertura: esquemaHoraLocal,
  horaCierre: esquemaHoraLocal,
  inicioPausa: esquemaHoraLocal.nullable(),
  finPausa: esquemaHoraLocal.nullable(),
});

export type HorarioBarberia = z.infer<typeof esquemaHorarioBarberia>;

// Bloqueo de toda la barberia que aun no termina y empieza dentro de diasMaxAnticipacion; sin motivo.
export const esquemaCierreBarberia = z.object({
  iniciaEn: z.iso.datetime(),
  terminaEn: z.iso.datetime(),
});

export type CierreBarberia = z.infer<typeof esquemaCierreBarberia>;

export const esquemaDetalleBarberia = z.object({
  id: z.uuid(),
  nombre: z.string(),
  descripcion: z.string().nullable(),
  direccion: z.string(),
  telefono: z.string(),
  urlPortada: z.string().nullable(),
  abierta: z.boolean(),
  horarios: z.array(esquemaHorarioBarberia),
  cierres: z.array(esquemaCierreBarberia),
  // Zona IANA de la barberia (T3.2): la app muestra en ella las horas de la disponibilidad.
  zonaHoraria: z.string(),
  // Solo para miembros ACTIVO de la barberia (D-32); nunca para el resto.
  publicada: z.boolean().optional(),
  activo: z.boolean().optional(),
});

export type DetalleBarberia = z.infer<typeof esquemaDetalleBarberia>;

export const esquemaRespuestaDetalleBarberia = z.object({ datos: esquemaDetalleBarberia });

export type RespuestaDetalleBarberia = z.infer<typeof esquemaRespuestaDetalleBarberia>;

const esquemaMetaTotal = z.object({ total: z.number().int() });

// Servicios activos, GET /barberias/:id/servicios (BUS-06, HU-BUS-02, RN-21). Sin paginar.
export const esquemaServicioBarberia = z.object({
  id: z.uuid(),
  nombre: z.string(),
  descripcion: z.string().nullable(),
  precio: z.string().regex(/^\d+\.\d{2}$/), // dinero como texto con 2 decimales ("25.00")
  duracionMinutos: z.number().int(),
});

export type ServicioBarberia = z.infer<typeof esquemaServicioBarberia>;

export const esquemaRespuestaServiciosBarberia = z.object({
  datos: z.array(esquemaServicioBarberia),
  meta: esquemaMetaTotal,
});

export type RespuestaServiciosBarberia = z.infer<typeof esquemaRespuestaServiciosBarberia>;

// Barberos, GET /barberias/:id/barberos (BUS-07). id es el PerfilBarbero; servicios son ids de
// servicios activos. Sin datos de contacto. Sin paginar.
export const esquemaBarberoBarberia = z.object({
  id: z.uuid(),
  nombreVisible: z.string(),
  urlFoto: z.string().nullable(),
  servicios: z.array(z.uuid()),
});

export type BarberoBarberia = z.infer<typeof esquemaBarberoBarberia>;

export const esquemaRespuestaBarberosBarberia = z.object({
  datos: z.array(esquemaBarberoBarberia),
  meta: esquemaMetaTotal,
});

export type RespuestaBarberosBarberia = z.infer<typeof esquemaRespuestaBarberosBarberia>;

// Disponibilidad, GET /barberias/:id/disponibilidad y /disponibilidad/dias (RES-03, RES-04, D1, D5).
// Fechas locales AAAA-MM-DD de la barberia (su zonaHoraria); instantes en ISO 8601 UTC.
const FORMATO_FECHA_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

// Dias desde el 1970-01-01 de una fecha AAAA-MM-DD ya validada (calendario gregoriano, sin zona).
function diasDesdeEpoca(fecha: string): number {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];
  return Date.UTC(anio, mes - 1, dia) / 86_400_000;
}

// Rechaza fechas inexistentes (2026-02-30) comprobando que el dia calculado vuelve a la misma fecha.
function esFechaExistente(fecha: string): boolean {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];
  const calculada = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    calculada.getUTCFullYear() === anio &&
    calculada.getUTCMonth() === mes - 1 &&
    calculada.getUTCDate() === dia
  );
}

const esquemaFechaLocal = (campo: string) =>
  z
    .string({ error: `${campo} es obligatoria` })
    .regex(FORMATO_FECHA_LOCAL, `${campo} debe tener el formato AAAA-MM-DD`)
    .refine(esFechaExistente, `${campo} no existe en el calendario`);

const esquemaIdConsulta = (campo: string) =>
  z.uuid({ error: `${campo} debe ser un identificador válido` });

// Maximo de dias (inclusive) de /disponibilidad/dias (RES-03).
export const MAXIMO_DIAS_DISPONIBILIDAD = 31;

// Sin barberoId = Cualquiera disponible (RES-02). barberoId es el id del PerfilBarbero.
export const esquemaConsultaDisponibilidad = z.strictObject(
  {
    servicioId: esquemaIdConsulta('servicioId'),
    barberoId: esquemaIdConsulta('barberoId').optional(),
    fecha: esquemaFechaLocal('La fecha'),
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Parámetros no permitidos: ${problema.keys.join(', ')}`
        : 'Revisa la consulta de disponibilidad',
  },
);

export type ConsultaDisponibilidad = z.infer<typeof esquemaConsultaDisponibilidad>;

export const esquemaConsultaDiasDisponibles = z
  .strictObject(
    {
      servicioId: esquemaIdConsulta('servicioId'),
      barberoId: esquemaIdConsulta('barberoId').optional(),
      desde: esquemaFechaLocal('La fecha desde'),
      hasta: esquemaFechaLocal('La fecha hasta'),
    },
    {
      error: (problema) =>
        problema.code === 'unrecognized_keys'
          ? `Parámetros no permitidos: ${problema.keys.join(', ')}`
          : 'Revisa la consulta de disponibilidad',
    },
  )
  .superRefine((consulta, contexto) => {
    const dias = diasDesdeEpoca(consulta.hasta) - diasDesdeEpoca(consulta.desde) + 1;
    if (dias < 1) {
      contexto.addIssue({
        code: 'custom',
        path: ['hasta'],
        message: 'hasta no puede ser anterior a desde',
      });
    } else if (dias > MAXIMO_DIAS_DISPONIBILIDAD) {
      contexto.addIssue({
        code: 'custom',
        path: ['hasta'],
        message: `El rango es de máximo ${MAXIMO_DIAS_DISPONIBILIDAD} días`,
      });
    }
  });

export type ConsultaDiasDisponibles = z.infer<typeof esquemaConsultaDiasDisponibles>;

// Inicios libres de una fecha, ascendentes y sin repetir; nunca indica barbero (D1).
export const esquemaHorarioDisponible = z.object({ iniciaEn: z.iso.datetime() });

export type HorarioDisponible = z.infer<typeof esquemaHorarioDisponible>;

export const esquemaDisponibilidad = z.object({
  fecha: z.string().regex(FORMATO_FECHA_LOCAL),
  horarios: z.array(esquemaHorarioDisponible),
});

export type Disponibilidad = z.infer<typeof esquemaDisponibilidad>;

export const esquemaRespuestaDisponibilidad = z.object({ datos: esquemaDisponibilidad });

export type RespuestaDisponibilidad = z.infer<typeof esquemaRespuestaDisponibilidad>;

// Un elemento por dia del rango pedido, en orden; disponible si conserva al menos un inicio (CU-07).
export const esquemaDiaDisponible = z.object({
  fecha: z.string().regex(FORMATO_FECHA_LOCAL),
  disponible: z.boolean(),
});

export type DiaDisponible = z.infer<typeof esquemaDiaDisponible>;

export const esquemaRespuestaDiasDisponibles = z.object({ datos: z.array(esquemaDiaDisponible) });

export type RespuestaDiasDisponibles = z.infer<typeof esquemaRespuestaDiasDisponibles>;

// Crear cita, POST /citas (RES-06, RN-01, RN-10, RES-12, D2, D6). barberoId es el PerfilBarbero;
// sin el = Cualquiera disponible (CU-07 A3). iniciaEn: ISO 8601 con Z o cualquier desfase; la API
// lo normaliza a UTC. Debe caer en un bloque de 15 minutos exacto, sin segundos (D6): comprobarlo
// en UTC equivale a hacerlo en la hora local porque los desfases son multiplos de 15 minutos.
export const MINUTOS_BLOQUE_CITA = 15;
export const MAXIMO_NOTAS_CITA = 200;

function enBloqueDeCita(valor: string): boolean {
  const instante = new Date(valor);
  return (
    !Number.isNaN(instante.getTime()) &&
    instante.getUTCMinutes() % MINUTOS_BLOQUE_CITA === 0 &&
    instante.getUTCSeconds() === 0 &&
    instante.getUTCMilliseconds() === 0
  );
}

export const esquemaCrearCita = z.strictObject(
  {
    barberiaId: z.uuid({ error: 'barberiaId debe ser un identificador válido' }),
    servicioId: z.uuid({ error: 'servicioId debe ser un identificador válido' }),
    barberoId: z.uuid({ error: 'barberoId debe ser un identificador válido' }).optional(),
    iniciaEn: z.iso
      .datetime({ offset: true, error: 'iniciaEn debe ser fecha y hora ISO 8601 con zona' })
      .refine(enBloqueDeCita, 'iniciaEn debe caer en un bloque de 15 minutos (:00, :15, :30, :45)'),
    // RES-12: se recorta; vacia = sin notas.
    notas: z
      .string({ error: 'Las notas deben ser texto' })
      .trim()
      .max(MAXIMO_NOTAS_CITA, `Las notas deben tener como máximo ${MAXIMO_NOTAS_CITA} caracteres`)
      .regex(SIN_CONTROL, 'Las notas no pueden tener caracteres de control')
      .optional(),
    claveIdempotencia: z.uuid({ error: 'claveIdempotencia debe ser un UUID' }),
  },
  {
    error: (problema) =>
      problema.code === 'unrecognized_keys'
        ? `Campos no permitidos: ${problema.keys.join(', ')}`
        : 'Revisa los datos de la reserva',
  },
);

export type EntradaCrearCita = z.infer<typeof esquemaCrearCita>;

export const ESTADOS_CITA = [
  'PENDIENTE',
  'CONFIRMADA',
  'COMPLETADA',
  'CANCELADA',
  'AUSENTE',
] as const;
export type EstadoCita = (typeof ESTADOS_CITA)[number];

// <cita> (D4): dinero como texto con 2 decimales; instantes en ISO 8601 UTC. puedeCancelar: estado
// PENDIENTE o CONFIRMADA y faltan al menos minutosMinCancelacion para el inicio (RN-13).
export const esquemaCita = z.object({
  id: z.uuid(),
  estado: z.enum(ESTADOS_CITA),
  iniciaEn: z.iso.datetime(),
  terminaEn: z.iso.datetime(),
  duracionReserva: z.number().int(),
  precioReserva: z.string().regex(/^\d+\.\d{2}$/),
  notas: z.string().nullable(),
  anticipoVenceEn: z.iso.datetime().nullable(),
  barberia: z.object({
    id: z.uuid(),
    nombre: z.string(),
    direccion: z.string(),
    telefono: z.string(),
  }),
  servicio: z.object({ id: z.uuid(), nombre: z.string() }),
  barbero: z.object({ id: z.uuid(), nombreVisible: z.string(), urlFoto: z.string().nullable() }),
  canceladaEn: z.iso.datetime().nullable(),
  motivoCancelacion: z.string().nullable(),
  puedeCancelar: z.boolean(),
});

export type Cita = z.infer<typeof esquemaCita>;

export const esquemaRespuestaCita = z.object({ datos: esquemaCita });

export type RespuestaCita = z.infer<typeof esquemaRespuestaCita>;
