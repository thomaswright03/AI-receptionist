import { createHmac, timingSafeEqual } from "node:crypto";

// Twilio signs each webhook: HMAC-SHA1 over the full URL plus every POST
// parameter (sorted by name, name and value concatenated), base64, in the
// X-Twilio-Signature header. https://www.twilio.com/docs/usage/security
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function validTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
