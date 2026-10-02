export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const isProduction = process.env.NODE_ENV === 'production';
export const sessionCookie = 'lop_session';
