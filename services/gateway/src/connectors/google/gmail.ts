export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
};

export type GmailHeader = { name: string; value: string };

export type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
};

export type GmailThread = {
  id: string;
  historyId?: string;
  snippet?: string;
  messages: GmailMessage[];
};

export type GmailHistoryItem = {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds?: string[] }>;
};

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string | undefined,
    public readonly providerMessage: string,
  ) {
    super(`Gmail API request failed (${status}${reason ? `: ${reason}` : ""})`);
    this.name = "GmailApiError";
  }
}

type GmailErrorPayload = {
  error?: {
    message?: string;
    errors?: Array<{ reason?: string }>;
    status?: string;
  };
};

export class GmailClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(input: {
    accessToken: string;
    fetch?: typeof fetch;
    baseUrl?: string;
  }) {
    this.accessToken = input.accessToken;
    this.fetchImpl = input.fetch ?? fetch;
    this.baseUrl = input.baseUrl ?? "https://gmail.googleapis.com/gmail/v1/users/me";
  }

  private readonly accessToken: string;

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      let payload: GmailErrorPayload = {};
      try {
        payload = await response.json() as GmailErrorPayload;
      } catch {
        // Keep the error normalized even when Google returns non-JSON.
      }
      throw new GmailApiError(
        response.status,
        payload.error?.errors?.[0]?.reason ?? payload.error?.status,
        payload.error?.message ?? "Gmail provider error",
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  getProfile(): Promise<GmailProfile> {
    return this.request<GmailProfile>("/profile");
  }

  async listLabels(): Promise<GmailLabel[]> {
    const result = await this.request<{ labels?: GmailLabel[] }>("/labels");
    return result.labels ?? [];
  }

  async listThreads(input: {
    q?: string;
    labelIds?: string[];
    maxResults?: number;
    includeSpamTrash?: boolean;
  } = {}): Promise<{ threads: Array<{ id: string; snippet?: string; historyId?: string }>; resultSizeEstimate: number }> {
    const maxResults = Math.min(Math.max(input.maxResults ?? 100, 1), 500);
    const threads: Array<{ id: string; snippet?: string; historyId?: string }> = [];
    let pageToken: string | undefined;
    let resultSizeEstimate = 0;
    do {
      const query = new URLSearchParams({ maxResults: String(Math.min(500, maxResults - threads.length)) });
      if (input.q) query.set("q", input.q);
      for (const labelId of input.labelIds ?? []) query.append("labelIds", labelId);
      if (input.includeSpamTrash) query.set("includeSpamTrash", "true");
      if (pageToken) query.set("pageToken", pageToken);
      const result = await this.request<{
        threads?: Array<{ id: string; snippet?: string; historyId?: string }>;
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(`/threads?${query}`);
      threads.push(...(result.threads ?? []));
      resultSizeEstimate = Math.max(resultSizeEstimate, result.resultSizeEstimate ?? 0);
      pageToken = result.nextPageToken;
    } while (pageToken && threads.length < maxResults);
    return { threads: threads.slice(0, maxResults), resultSizeEstimate };
  }

  getThread(id: string, format: "full" | "metadata" | "minimal" = "full"): Promise<GmailThread> {
    return this.request<GmailThread>(`/threads/${encodeURIComponent(id)}?format=${format}`);
  }

  async listHistory(startHistoryId: string): Promise<{ history: GmailHistoryItem[]; historyId?: string }> {
    const history: GmailHistoryItem[] = [];
    let pageToken: string | undefined;
    let historyId: string | undefined;
    do {
      const query = new URLSearchParams({ startHistoryId, maxResults: "500" });
      if (pageToken) query.set("pageToken", pageToken);
      const result = await this.request<{
        history?: GmailHistoryItem[];
        nextPageToken?: string;
        historyId?: string;
      }>(`/history?${query}`);
      history.push(...(result.history ?? []));
      historyId = result.historyId ?? historyId;
      pageToken = result.nextPageToken;
    } while (pageToken);
    return { history, historyId };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data: Buffer; size: number }> {
    const result = await this.request<{ data?: string; size?: number }>(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return {
      data: Buffer.from(result.data ?? "", "base64url"),
      size: result.size ?? 0,
    };
  }

  modifyThread(
    id: string,
    labels: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<{ id: string; labelIds?: string[] }> {
    return this.request(`/threads/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: {
        addLabelIds: labels.addLabelIds ?? [],
        removeLabelIds: labels.removeLabelIds ?? [],
      },
    });
  }

  trashThread(id: string): Promise<GmailThread> {
    return this.request(`/threads/${encodeURIComponent(id)}/trash`, { method: "POST", body: {} });
  }

  untrashThread(id: string): Promise<GmailThread> {
    return this.request(`/threads/${encodeURIComponent(id)}/untrash`, { method: "POST", body: {} });
  }

  sendMessage(input: { raw: string; threadId?: string | null }): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
    return this.request("/messages/send", {
      method: "POST",
      body: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) },
    });
  }
}
