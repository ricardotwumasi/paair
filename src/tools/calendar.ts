import { createLogger } from '../logger.js';
import type { OfferBookingLinkArgs, AppConfig } from '../types.js';

const log = createLogger('booking');

const DURATION_MAP: Record<string, { configKey: keyof AppConfig['booking_links']; label: string }> = {
  short: { configKey: 'phone_15min', label: '15-minute phone call' },
  medium: { configKey: 'meeting_25min', label: '25-minute meeting' },
  long: { configKey: 'meeting_50min', label: '50-minute meeting' },
};

/**
 * Select the appropriate booking link based on the requested meeting duration.
 * Returns a formatted string with the booking URL and context for the LLM to include in its response.
 */
export function selectBookingLink(args: OfferBookingLinkArgs, config: AppConfig): string {
  const mapping = DURATION_MAP[args.duration_preference];
  if (!mapping) {
    log.warn('Unknown duration preference', { preference: args.duration_preference });
    // Default to medium
    const fallback = DURATION_MAP.medium;
    const url = config.booking_links[fallback.configKey];
    return JSON.stringify({
      booking_url: url,
      duration: fallback.label,
      context: args.context,
    });
  }

  const url = config.booking_links[mapping.configKey];

  log.info('Booking link selected', {
    duration: mapping.label,
    preference: args.duration_preference,
  });

  return JSON.stringify({
    booking_url: url,
    duration: mapping.label,
    context: args.context,
  });
}
