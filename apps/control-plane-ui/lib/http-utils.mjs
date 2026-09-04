export function json(res, status, payload) {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  res.end(JSON.stringify(payload));
}

export function jsonString(res, status, payload, extraHeaders) {
  res.writeHead(status, {"content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", ...(extraHeaders || {})});
  res.end(payload);
}

export function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (message, status) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.status = status;
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("error", () => fail("request_stream_error", 400));
    req.on("aborted", () => fail("request_aborted", 400));
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) {
        fail("request_body_too_large", 413);
        return;
      }
      settled = true;
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        settled = false;
        fail("request_body_invalid_json", 400);
      }
    });
  });
}
