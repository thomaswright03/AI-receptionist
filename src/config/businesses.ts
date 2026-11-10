import type { Business, CalEvent } from "./types.js";
import type { Env } from "./env.js";
import { wrightAiFaq } from "./faq/wright-ai.js";

// A Cal.com event link such as https://cal.com/thomas/intro-call, split into
// the username and slug the API wants. Same rule as the Wright AI website.
export function parseCalLink(link: string | undefined): CalEvent | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    const [username, slug, ...rest] = url.pathname.split("/").filter(Boolean);
    const part = /^[A-Za-z0-9_.-]{1,64}$/;
    if (url.protocol !== "https:" || !/^(app\.)?cal\.com$/.test(url.hostname) || rest.length) return undefined;
    if (!username || !slug || !part.test(username) || !part.test(slug)) return undefined;
    return { username, slug };
  } catch {
    return undefined;
  }
}

// Businesses live in code for the pilot; they move to the database once a
// second one exists and the shape has settled.
export function loadBusinesses(env: Env): Business[] {
  return [
    {
      id: "wright-ai",
      name: "Wright AI Solutions",
      about:
        "an AI consultancy in Tempe, Arizona that builds AI agents, lead follow-up, automation and websites for small businesses",
      timeZone: "America/Phoenix",
      flowId: "discovery-call",
      ownerPhone: env.OWNER_PHONE_WRIGHT_AI ?? "",
      ownerEmail: env.OWNER_EMAIL_WRIGHT_AI ?? "",
      inboundNumbers: env.WRIGHT_AI_NUMBER ? [env.WRIGHT_AI_NUMBER] : [],
      agentName: "Ava",
      voice: { provider: "11labs", voiceId: "sarah" },
      cal: parseCalLink(env.CAL_LINK_WRIGHT_AI),
      // Placeholder until Thomas sets his hours.
      transferHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      faq: wrightAiFaq,
      textBack:
        `Hi, this is Wright AI Solutions. This is an automated message. Sorry we missed your call! Reply here with what you need, or call back anytime and our assistant will pick up. Reply STOP to opt out. Privacy: ${env.PUBLIC_URL}/privacy`,
      caps: { callsPerDay: 100, textsPerDay: 50 },
    },
  ];
}

export function businessForNumber(businesses: Business[], number: string | undefined): Business | undefined {
  if (!number) return undefined;
  return businesses.find((b) => b.inboundNumbers.includes(number));
}
