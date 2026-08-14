export function parseModelRoute(value:string):{provider:string;model:string}{const [provider,model]=value.split(":");return{provider,model}}
