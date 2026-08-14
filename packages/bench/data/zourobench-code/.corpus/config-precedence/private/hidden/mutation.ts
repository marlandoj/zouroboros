export interface Config{model?:string|null;timeoutMs?:number|null;retries?:number|null} export function resolveConfig(...layers:Config[]):Config{return Object.assign({},...layers)}
