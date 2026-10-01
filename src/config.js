'use strict';

const isProd = process.env.NODE_ENV === 'production';

function required(name, devDefault) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (isProd) {
    throw new Error(`${name} is required when NODE_ENV=production`);
  }
  return devDefault;
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd,
  port: parseInt(process.env.PORT || '8080', 10),
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
  jwtSecret: required('JWT_SECRET', 'dev-jwt-secret-change-me'),
  adminToken: required('ADMIN_TOKEN', 'dev-admin-token'),
  pgPoolMax: parseInt(process.env.PG_POOL_MAX || '20', 10),
  holdTtlSeconds: parseInt(process.env.HOLD_TTL_SECONDS || '120', 10),
  defaultPerUserLimit: parseInt(process.env.DEFAULT_PER_USER_LIMIT || '4', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseSsl: process.env.DATABASE_SSL === 'true',
};

module.exports = config;
