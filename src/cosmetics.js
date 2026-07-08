// Cosmetics definitions (TR-37/TR-38). Extensible — add entries, never renumber.
// Banners come from record tiers, achievement grants, or future events.
export const BANNERS = {
  rookie:   { name: 'Rookie LED',     source: 'Default',                css: 'banner-rookie' },
  bronze:   { name: 'Bronze Segment', source: 'Win 5 matches',          css: 'banner-bronze' },
  silver:   { name: 'Silver Segment', source: 'Win 15 matches',         css: 'banner-silver' },
  gold:     { name: 'Gold Segment',   source: 'Win 40 matches',         css: 'banner-gold' },
  crown:    { name: 'Royale Crown',   source: 'Win 100 matches',        css: 'banner-crown' },
  bullseye: { name: 'Bullseye',       source: 'Achievement: Dead On',   css: 'banner-bullseye' },
  streak:   { name: 'Streak',        source: 'Achievement: Hat Trick',  css: 'banner-streak' }
};

export const ACHIEVEMENTS = {
  first_blood: { name: 'First Blood',   desc: 'Win your first 1v1' },
  dead_on:     { name: 'Dead On',       desc: 'Land within 0.05s of a target in a 1v1', grantsBanner: 'bullseye' },
  hat_trick:   { name: 'Hat Trick',     desc: 'Win 3 1v1s in a row', grantsBanner: 'streak' },
  clutch:      { name: 'Clutch Royale', desc: 'Win a match by less than 0.1s total' },
  ice_veins:   { name: 'Ice Veins',     desc: 'Win a hard-mode 1v1' },
  oracle:      { name: 'Oracle',        desc: 'Guess within 0.15s in a Guess Timer 1v1' },
  grinder:     { name: 'Grinder',       desc: 'Complete 10 matches' },
  comeback:    { name: 'Comeback Kid',  desc: 'Win after losing the first two rounds' }
};

/** Record-tier banner earned for a given win count (highest applicable). */
export function tierBannerFor(wins) {
  if (wins >= 100) return 'crown';
  if (wins >= 40) return 'gold';
  if (wins >= 15) return 'silver';
  if (wins >= 5) return 'bronze';
  return 'rookie';
}
