export function retryDelayMs(status:number,retryAfter:string|null,_now:number,_cap=60_000):number|null { if (status!==429) return null; return retryAfter?Number(retryAfter)*1000:60_000; }
