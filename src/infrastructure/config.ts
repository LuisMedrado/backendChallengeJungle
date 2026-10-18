// leitura de variável de ambiente num lugar só

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definida, copia o .env.example pra .env`);
  return value;
}

// inteiro positivo ou o padrão, valor inválido não derruba o boot
export function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value === 'true';
}
