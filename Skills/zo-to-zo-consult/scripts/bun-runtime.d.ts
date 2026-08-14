interface ImportMeta {
  readonly main: boolean;
  readonly dir: string;
}

declare const Bun: {
  readonly argv: string[];
  sleep(milliseconds: number): Promise<void>;
  serve(options: {
    port: number;
    hostname?: string;
    fetch(request: Request): Response | Promise<Response>;
  }): {
    readonly port: number;
  };
};
