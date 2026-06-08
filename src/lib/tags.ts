export const SCOUT_TAGS = [
  'Bævere',
  'Ulve',
  'Stifindere',
  'Spejdere',
  'Pionerer',
  'Rovere',
  'Ledere',
  'Forældre',
] as const

const SCOUT_TAG_LOOKUP = new Map(SCOUT_TAGS.map((tag) => [tag.toLowerCase(), tag]))

export function normalizeScoutTags(tags: readonly string[] | undefined): string[] {
  if (!Array.isArray(tags)) {
    return []
  }

  const normalized = tags
    .map((tag) => SCOUT_TAG_LOOKUP.get(tag.trim().toLowerCase()))
    .filter((tag): tag is (typeof SCOUT_TAGS)[number] => typeof tag === 'string')

  return Array.from(new Set(normalized))
}
