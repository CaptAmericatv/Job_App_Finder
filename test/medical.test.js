import test from 'node:test';
import assert from 'node:assert/strict';
import { isMedicalTitle, isMedicalJob } from '../src/medical.js';

test('medical titles are caught', () => {
  for (const t of [
    'Home Health Nurses', 'Nurse - Hourly (Wellness Nurses)', 'RN - Med/Surg', 'LPN', 'CNA Night Shift',
    'Caregiver', 'Patient Care Technician', 'General Surgeon', 'OBGYN', 'Urologist', 'Internal Medicine',
    'Medical Records Clerk', 'Bureau of Clinical Laboratories Positions', 'Pharmacy Technician', 'Pharmacist',
    'Dental Hygienist', 'Physical Therapist', 'Phlebotomist', 'EMT-Basic', 'Paramedic', 'X-Ray Tech',
    'Sonographer', 'Lab Tech', 'Health Specialist - Hourly (Breastfeeding Peer Counselors)', 'Healthcare Staff',
    'Disease Intervention Specialist (DIS)', 'Health Services Administrators', 'Veterinary Assistant',
    'Vet Tech', 'Family Physician', 'Doctor of Optometry',
  ]) assert.ok(isMedicalTitle(t), t);
});

test('ordinary titles are not caught', () => {
  for (const t of [
    'Lead Line Cook', 'Kitchen Staff', 'Hospitality Associate', 'Health & Beauty Clerk', 'Massage Therapist',
    'Labor Crew', 'Unit Leader', 'Program Director', 'Pool Director', 'Federal Work Study - Biology',
    'Assistant Manager', 'Driver', 'Veterans Welcome - Warehouse Associate', 'Ernest Learning Center Aide',
    'Assistant Professor, Emergency Management and Public Administration',
  ]) assert.ok(!isMedicalTitle(t), t);
});

test('medical roles from classifyRole count too', () => {
  assert.ok(isMedicalJob({ title: 'Direct Support Professional' })); // cna role
  assert.ok(isMedicalJob({ title: 'Anything', role: 'nurse' }));
  assert.ok(!isMedicalJob({ title: 'Cashier' }));
});
