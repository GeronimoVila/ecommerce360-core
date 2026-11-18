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
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  res.cookie('refresh_token', rawRefreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/api/v1/auth',
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

  const user = await prismaGlobal.user.findUnique({ where: { email } });
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
    include: { user: true },
  });

  if (!storedToken || storedToken.revoked_at) {
    if (storedToken?.user_id) {
      await prismaGlobal.refreshToken.updateMany({
        where: { user_id: storedToken.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/api/v1/auth' });
    res.status(401).json({ error: 'Sesión inválida o comprometida. Inicia sesión nuevamente.' });
    return;
  }

  if (storedToken.expires_at < new Date() || !storedToken.user.is_active) {
    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/api/v1/auth' });
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

  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/v1/auth' });
  res.json({ message: 'Logout exitoso' });
};

export const registerCustomer = async (req: Request, res: Response): Promise<void> => {
  const { email, password, first_name, last_name, phone } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, 10);

    const newCustomer = await prismaGlobal.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          password_hash,
          role: 'CUSTOMER',
        },
      });

      const profile = await tx.customerProfile.create({
        data: {
          user_id: user.id,
          first_name,
          last_name,
          phone,
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

  res.json({
    user: {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    },
  });
};