import { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from '../redis/redis.service';
import { prismaGlobal } from '../config/prisma';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ETERNAL_SLIDING_DAYS = 400;
const ETERNAL_SLIDING_MS = ETERNAL_SLIDING_DAYS * 24 * 60 * 60 * 1000;
const SESSION_ONLY_DB_HOURS = 24;

const hashToken = (rawToken: string): string =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

const issueAuthCookies = (
  res: Response,
  user: { id: string; email: string; role: string },
  rawRefreshToken: string,
  rememberMe: boolean
) => {
  const isProd = process.env.NODE_ENV === 'production';
  const jti = uuidv4();

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, jti },
    process.env.JWT_SECRET!,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  );

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  res.cookie('refresh_token', rawRefreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    ...(rememberMe ? { maxAge: ETERNAL_SLIDING_MS } : {}),
  });

  return accessToken;
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password, rememberMe = false } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email y contraseña son obligatorios' });
    return;
  }

  const user = await prismaGlobal.user.findUnique({
    where: { email },
    include: {
      customer_profile: {
        select: { id: true, dni: true, first_name: true, last_name: true, phone: true },
      },
    },
  });
  if (!user || !user.is_active) {
    res.status(401).json({ error: 'Credenciales inválidas o cuenta inactiva' });
    return;
  }

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) {
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const isPersistent = Boolean(rememberMe);
  const rawRefreshToken = crypto.randomBytes(48).toString('hex');
  const expiresAt = isPersistent
    ? new Date(Date.now() + ETERNAL_SLIDING_MS)
    : new Date(Date.now() + SESSION_ONLY_DB_HOURS * 60 * 60 * 1000);

  await prismaGlobal.refreshToken.create({
    data: {
      user_id: user.id,
      token_hash: hashToken(rawRefreshToken),
      remember_me: isPersistent,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
      expires_at: expiresAt,
    },
  });

  issueAuthCookies(res, user, rawRefreshToken, isPersistent);

  res.json({
    message: 'Login exitoso',
    rememberMe: isPersistent,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      customer_profile: user.customer_profile,
    },
  });
};

export const refreshSession = async (req: Request, res: Response): Promise<void> => {
  const incomingRefreshToken = req.cookies?.refresh_token;

  if (!incomingRefreshToken) {
    res.status(401).json({ error: 'Refresh token no proporcionado' });
    return;
  }

  const incomingHash = hashToken(incomingRefreshToken);

  const storedToken = await prismaGlobal.refreshToken.findUnique({
    where: { token_hash: incomingHash },
    include: {
      user: {
        include: {
          customer_profile: {
            select: { id: true, dni: true, first_name: true, last_name: true, phone: true },
          },
        },
      },
    },
  });

  if (!storedToken || storedToken.revoked_at) {
    if (storedToken?.user_id) {
      await prismaGlobal.refreshToken.updateMany({
        where: { user_id: storedToken.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/' });
    res.status(401).json({ error: 'Sesión inválida o comprometida. Inicia sesión nuevamente.' });
    return;
  }

  if (storedToken.expires_at < new Date() || !storedToken.user.is_active) {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/' });
    res.status(401).json({ error: 'La sesión ha expirado o la cuenta está inactiva.' });
    return;
  }

  const newRawRefreshToken = crypto.randomBytes(48).toString('hex');
  const nextExpiresAt = storedToken.remember_me
    ? new Date(Date.now() + ETERNAL_SLIDING_MS)
    : new Date(Date.now() + SESSION_ONLY_DB_HOURS * 60 * 60 * 1000);

  await prismaGlobal.$transaction([
    prismaGlobal.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked_at: new Date() },
    }),
    prismaGlobal.refreshToken.create({
      data: {
        user_id: storedToken.user_id,
        token_hash: hashToken(newRawRefreshToken),
        remember_me: storedToken.remember_me,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
        expires_at: nextExpiresAt,
      },
    }),
  ]);

  issueAuthCookies(res, storedToken.user, newRawRefreshToken, storedToken.remember_me);

  res.json({
    message: 'Sesión renovada',
    user: {
      id: storedToken.user.id,
      email: storedToken.user.email,
      role: storedToken.user.role,
      customer_profile: storedToken.user.customer_profile,
    },
  });
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  const payload = req.user;
  const incomingRefreshToken = req.cookies?.refresh_token;

  if (payload && payload.jti && payload.exp) {
    await RedisService.banToken(payload.jti, payload.exp);
  }

  if (incomingRefreshToken) {
    await prismaGlobal.refreshToken.updateMany({
      where: { token_hash: hashToken(incomingRefreshToken), revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' });
  res.json({ message: 'Logout exitoso' });
};

export const registerCustomer = async (req: Request, res: Response): Promise<void> => {
  const { email, password, first_name, last_name, phone, dni } = req.body;

  const cleanDni = typeof dni === 'string' ? dni.replace(/\D/g, '').trim() : '';

  if (!email || !password || !first_name || !last_name || !cleanDni) {
    res.status(400).json({ error: 'Nombre, apellido, DNI, email y contraseña son obligatorios' });
    return;
  }

  if (cleanDni.length < 7 || cleanDni.length > 11) {
    res.status(400).json({ error: 'El DNI/CUIT debe tener entre 7 y 11 dígitos numéricos' });
    return;
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);

    const newCustomer = await prismaGlobal.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: email.trim().toLowerCase(),
          password_hash,
          role: 'CUSTOMER',
        },
      });

      const profile = await tx.customerProfile.create({
        data: {
          user_id: user.id,
          dni: cleanDni,
          first_name: first_name.trim(),
          last_name: last_name.trim(),
          phone: phone?.trim() || null,
        },
      });

      return { user, profile };
    });

    res.status(201).json({
      message: 'Cliente registrado exitosamente',
      customer_id: newCustomer.profile.id,
      email: newCustomer.user.email,
    });
  } catch (error: any) {
    if (error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target)
        ? error.meta.target.join(',')
        : String(error.meta?.target || '');
      if (target.includes('dni')) {
        res.status(409).json({ error: 'Ya existe una cuenta registrada con ese DNI' });
        return;
      }
      res.status(409).json({ error: 'El email ya se encuentra registrado' });
      return;
    }
    res.status(500).json({ error: 'Error interno al registrar cliente' });
  }
};

export const getSession = async (req: Request, res: Response): Promise<void> => {
  const payload = req.user;

  if (!payload || !payload.sub) {
    res.status(401).json({ error: 'Sesión inválida' });
    return;
  }

  try {
    const user = await prismaGlobal.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        customer_profile: {
          select: {
            id: true,
            dni: true,
            first_name: true,
            last_name: true,
            phone: true,
          },
        },
        seller_profile: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            ref_code: true,
          },
        },
      },
    });

    if (!user || !user.is_active) {
      res.status(401).json({ error: 'Usuario no encontrado o inactivo' });
      return;
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        customer_profile: user.customer_profile,
        seller_profile: user.seller_profile,
      },
    });
  } catch (error) {
    console.error('[AuthController.getSession] Error:', error);
    res.status(500).json({ error: 'Error al obtener la sesión del usuario' });
  }
};