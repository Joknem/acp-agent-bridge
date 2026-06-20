export type QqAccessTokenProviderOptions = {
  appId: string;
  appSecret?: string;
  legacyToken?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
};

type CachedAccessToken = {
  authorization: string;
  expiresAt: number;
};

const DEFAULT_TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export class QqAccessTokenProvider {
  private cached?: CachedAccessToken;
  private pending?: Promise<string>;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;

  constructor(private readonly options: QqAccessTokenProviderOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  async authorization() {
    if (!this.options.appSecret) {
      if (!this.options.legacyToken) {
        throw new Error("QQ bot auth requires QQ_BOT_APP_SECRET or QQ_BOT_TOKEN.");
      }
      return `Bot ${this.options.appId}.${this.options.legacyToken}`;
    }

    if (this.cached && this.now() < this.cached.expiresAt - this.refreshSkewMs) {
      return this.cached.authorization;
    }

    this.pending ??= this.fetchAccessToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchAccessToken() {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        appId: this.options.appId,
        clientSecret: this.options.appSecret,
      }),
    });

    const body = await response.text();
    const payload = parseJsonObject(body);
    if (!response.ok) {
      throw new Error(`QQ access token fetch failed: ${response.status} ${body}`);
    }

    const accessToken = payload.access_token;
    const expiresIn = Number(payload.expires_in);
    if (typeof accessToken !== "string" || !accessToken.trim() || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error(`QQ access token response is invalid: ${body}`);
    }

    const authorization = `QQBot ${accessToken}`;
    this.cached = {
      authorization,
      expiresAt: this.now() + expiresIn * 1000,
    };
    return authorization;
  }
}

function parseJsonObject(text: string) {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
