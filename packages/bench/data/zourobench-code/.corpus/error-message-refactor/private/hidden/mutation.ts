export interface ProviderError{kind:string;provider:string;status?:number;message:string} export function providerError(error:ProviderError):string{return JSON.stringify(error)}
