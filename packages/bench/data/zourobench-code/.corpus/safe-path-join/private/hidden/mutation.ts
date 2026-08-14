import { resolve } from "node:path";
export function safeJoin(root:string,input:string):string { const path=resolve(root,input); if(!path.startsWith(resolve(root))) throw new Error("escape"); return path; }
