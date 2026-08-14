import { isAbsolute, relative, resolve, sep } from "node:path";
export function safeJoin(root:string,input:string):string { if(isAbsolute(input)) throw new Error("absolute path rejected"); const base=resolve(root); const path=resolve(base,input); const rel=relative(base,path); if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)) throw new Error("path escapes root"); return path; }
