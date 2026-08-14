// Minimal Hetzner Cloud (hcloud) REST client. Only the calls the sandbox
// provider needs: create / get / poweron / delete a server. Kept as an
// interface so the sandbox provider is unit-testable without a real token
// or network (tests inject a FakeHcloudClient).

export class HcloudError extends Error {}

export interface CreateServerInput {
  name: string;
  serverType: string;
  image: string;
  location: string;
  sshKeyName: string;
  /** cloud-init user_data (raw YAML string; client base64-encodes per API). */
  userData: string;
  labels?: Record<string, string>;
}

export interface HcloudServer {
  id: number;
  name: string;
  status: string;
  publicIp?: string;
}

export interface HcloudClient {
  createServer(input: CreateServerInput): Promise<HcloudServer>;
  getServer(id: number): Promise<HcloudServer>;
  powerOn(id: number): Promise<void>;
  deleteServer(id: number): Promise<void>;
}

const HCLOUD_API = "https://api.hetzner.cloud/v1";

/** Real hcloud client using global `fetch` + a bearer token. */
export class HcloudHttpClient implements HcloudClient {
  constructor(private readonly token: string) {
    if (!token) throw new HcloudError("HcloudHttpClient requires a non-empty API token");
  }

  private async req(path: string, method: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${HCLOUD_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new HcloudError(`hcloud ${method} ${path} network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new HcloudError(`hcloud ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async createServer(input: CreateServerInput): Promise<HcloudServer> {
    const body = {
      name: input.name,
      server_type: input.serverType,
      image: input.image,
      location: input.location,
      ssh_keys: [input.sshKeyName],
      user_data: input.userData,
      labels: input.labels ?? {},
      public_net: { enable_ipv4: true, enable_ipv6: false },
      automount: false,
      start_server: true,
    };
    const j = (await this.req("/servers", "POST", body)) as { server: RawServer };
    return normalize(j.server);
  }

  async getServer(id: number): Promise<HcloudServer> {
    const j = (await this.req(`/servers/${id}`, "GET")) as { server: RawServer };
    return normalize(j.server);
  }

  async powerOn(id: number): Promise<void> {
    await this.req(`/servers/${id}/actions/poweron`, "POST");
  }

  async deleteServer(id: number): Promise<void> {
    await this.req(`/servers/${id}`, "DELETE");
  }
}

interface RawServer {
  id: number;
  name: string;
  status: string;
  public_net?: { ipv4?: { ip?: string } };
}

function normalize(s: RawServer): HcloudServer {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    publicIp: s.public_net?.ipv4?.ip,
  };
}
