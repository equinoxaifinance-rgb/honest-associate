import { defineField, defineType } from 'sanity'

// The honest-edges banner as a DOCUMENT: the corpus states its own boundaries, and the agent
// reads them at session start so "not in my corpus" is always scoped, never universal.
export const corpusInfo = defineType({
  name: 'corpusInfo',
  title: 'Corpus Boundaries',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Corpus Name',
      type: 'string',
      initialValue: 'Honest Associate Corpus',
    }),
    defineField({
      name: 'courtsCovered',
      title: 'Courts Covered',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'dateRangeStart',
      title: 'Earliest Opinion Date',
      type: 'date',
    }),
    defineField({
      name: 'dateRangeEnd',
      title: 'Latest Opinion Date',
      type: 'date',
    }),
    defineField({
      name: 'opinionCount',
      title: 'Opinion Count',
      type: 'number',
    }),
    defineField({
      name: 'source',
      title: 'Source',
      type: 'string',
      initialValue: 'CourtListener / Free Law Project (public domain)',
    }),
    defineField({
      name: 'ingestedAt',
      title: 'Last Ingest Date',
      type: 'datetime',
    }),
    defineField({
      name: 'disclaimer',
      title: 'Disclaimer',
      type: 'text',
      initialValue:
        'This corpus is a bounded snapshot. "Not in corpus" means not in THIS collection — never that no authority exists. This tool is a research aid, not legal advice.',
    }),
  ],
})
