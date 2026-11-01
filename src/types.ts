export const JOB_STATUSES = ['DISCOVERED', 'REJECTED', 'STAGED', 'APPLIED', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Workplace = 'remote' | 'hybrid' | 'onsite';

/** A posting as a source adapter returns it, before it touches the database. */
export interface RawJob {
  platform: string;
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl?: string | null;
  /** Plain text, HTML already stripped. */
  description: string;
  postedAt?: string | null;
  workplace?: Workplace | null;
  salary?: string | null;
  /** Seniority labels a source provides itself (e.g. Himalayas "Senior"). */
  seniorityHints?: string[];
}

export interface WorkEntry {
  company: string;
  title: string;
  start: string;
  end: string;
  highlights: string[];
}

export interface CandidateProfile {
  name: string;
  contact: { email: string; phone: string; linkedin: string; github: string; links: string[] };
  summary: string;
  skills: string[];
  yearsExperience: number;
  education: { institution: string; degree: string; start: string; end: string }[];
  workHistory: WorkEntry[];
  projects: { name: string; tech: string[]; highlights: string[] }[];
  certifications: string[];
  /** Full resume text, used for keyword matching. */
  rawText: string;
  parsedBy: 'rules' | 'claude';
  sourceHash: string;
}

export interface ScreeningAnswer {
  question: string;
  answer: string;
}

export interface MatchResult {
  matchScore: number;
  isQualified: boolean;
  matchedSkills: string[];
  missingSkills: string[];
  experienceRequired: string | null;
  reason: string;
  tailoredAnswers: ScreeningAnswer[];
  shortPitch: string;
  scorer: 'rules' | 'claude';
}
