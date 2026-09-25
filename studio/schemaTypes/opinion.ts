import { defineField, defineType } from 'sanity'

// One court opinion, ingested from CourtListener (public domain). The schema is the trust
// architecture: every field an agent cites must exist HERE, typed, with provenance — an answer
// that cannot point at a document in this type does not get spoken.
export const opinion = defineType({
  name: 'opinion',
  title: 'Court Opinion',
  type: 'document',
  fields: [
    defineField({
      name: 'caseName',
      title: 'Case Name',
      type: 'string',
      description: 'e.g. "Smith v. Jones" — exactly as filed',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'citations',
      title: 'Reporter Citations',
      type: 'array',
      of: [{ type: 'string' }],
      description: 'e.g. "123 F.4th 456" — every known reporter citation for this opinion',
    }),
    defineField({
      name: 'court',
      title: 'Court',
      type: 'string',
      options: {
        list: [
          { title: 'Supreme Court of the United States', value: 'scotus' },
          { title: 'Court of Appeals for the Fourth Circuit', value: 'ca4' },
        ],
      },
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'dateFiled',
      title: 'Date Filed',
      type: 'date',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'docketNumber',
      title: 'Docket Number',
      type: 'string',
    }),
    defineField({
      name: 'precedentialStatus',
      title: 'Precedential Status',
      type: 'string',
      options: { list: ['Published', 'Unpublished', 'Errata', 'Separate', 'In-chambers', 'Relating-to', 'Unknown'] },
      description: 'Only Published opinions bind future panels — the agent must say which kind it is citing',
    }),
    defineField({
      name: 'judges',
      title: 'Judges / Panel',
      type: 'string',
    }),
    defineField({
      name: 'summary',
      title: 'Summary / Syllabus',
      type: 'text',
      description: 'CourtListener-provided summary or headmatter, when present',
    }),
    defineField({
      name: 'fullText',
      title: 'Opinion Text',
      type: 'text',
      description: 'Plain text of the opinion — the ONLY ground the agent may quote from',
    }),
    defineField({
      name: 'courtListenerId',
      title: 'CourtListener Cluster ID',
      type: 'number',
      description: 'Provenance: the source record id at courtlistener.com',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'absoluteUrl',
      title: 'Source URL',
      type: 'url',
      description: 'Public link to the opinion on CourtListener — every citation card links here',
    }),
  ],
  preview: {
    select: { title: 'caseName', subtitle: 'dateFiled', court: 'court' },
    prepare({ title, subtitle, court }) {
      return { title, subtitle: `${court === 'scotus' ? 'SCOTUS' : '4th Cir.'} · ${subtitle}` }
    },
  },
})
