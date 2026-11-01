// Spots medical-field jobs, for the "Hide medical jobs" setting.
// Runs in both Node and the browser (served as /lib/medical.js).
import { classifyRole } from './estimate.js';

// Title words that mark a medical job. Each entry is matched as a whole word
// (case-insensitive); `\w*` lets one entry cover "urologist", "urology", etc.
// Bare "health" and "lab" are left out on purpose ("Health & Safety", "Lab Assistant"
// at a school); the phrases below catch the medical uses.
export const MEDICAL_TITLE_WORDS = [
  'nurs(e|es|ing)', 'rns?', 'lpns?', 'lvns?', 'cnas?', 'crnas?', 'caregivers?', 'care ?givers?',
  'home health', 'patient care', 'patient care tech\\w*', 'hospice', 'medication aides?', 'med techs?',
  'physicians?', 'doctors?', 'surgeons?', 'surgical', 'surgery', 'ob ?/? ?gyn', 'urolog\\w*', 'cardiolog\\w*',
  'oncolog\\w*', 'pediatric\\w*', 'neurolog\\w*', 'dermatolog\\w*', 'anesthes\\w*', 'midwi(fe|ves)',
  'internal medicine', 'family medicine', 'medicine', 'medical', 'clinical', 'clinics?', 'clinicians?',
  'hospitals?', 'hospitalists?', 'pharmacy', 'pharmacists?', 'pharm techs?', 'dental', 'dentists?',
  'hygienists?', 'orthodont\\w*', 'optometr\\w*', 'chiropract\\w*', 'audiolog\\w*', 'dietitians?',
  'therapists?', 'therapy', 'phlebotom\\w*', 'emts?', 'paramedics?', 'radiolog\\w*', 'x-?ray',
  'sonograph\\w*', 'ultrasound', 'mri', 'lab techs?', 'laboratory', 'laboratories', 'health specialists?',
  'health ?care', 'health services', 'behavioral health', 'mental health', 'public health',
  'disease intervention', 'respiratory', 'sterile processing', 'veterinar\\w*', 'vet', 'vet techs?',
];
const MEDICAL_RE = new RegExp(`\\b(?:${MEDICAL_TITLE_WORDS.join('|')})\\b`, 'i');
// Titles that use a medical word for something that isn't medical work.
const NOT_MEDICAL_RE = /\bmassage therap/i;
// Role keys from classifyRole() that are always medical work.
export const MEDICAL_ROLES = new Set(['cna', 'nurse', 'medical']);

export function isMedicalTitle(title) {
  const t = String(title || '');
  return MEDICAL_RE.test(t) && !NOT_MEDICAL_RE.test(t);
}

/** job: { title, role? } — role is filled in by applyEstimates(); worked out here if missing. */
export function isMedicalJob(job) {
  if (isMedicalTitle(job?.title)) return true;
  return MEDICAL_ROLES.has(job?.role || classifyRole(job?.title)[0]);
}
