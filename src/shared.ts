export type SharedModule = Record<string, unknown>

export interface SharedModules {
  types?: SharedModule
  state?: SharedModule
}

const CANDIDATES = ['types', 'state'] as const

export async function tryLoadShared(): Promise<SharedModules> {
  const out: SharedModules = {}
  for (const name of CANDIDATES) {
    try {
      out[name] = (await import(/* @vite-ignore */ `./${name}.ts`)) as SharedModule
    } catch {}
  }
  return out
}
