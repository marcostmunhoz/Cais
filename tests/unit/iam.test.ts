import { describe, expect, it } from 'vitest';
import { deriveIamUsername, deriveIamUsernameFor, looksLikeProduction } from '@shared/model';

describe('IAM database user derivation', () => {
  it('uses the part before @ for user accounts', () => {
    expect(deriveIamUsername('maria.silva@empresa.com')).toBe('maria.silva');
  });
  it('drops .gserviceaccount.com for service accounts', () => {
    expect(deriveIamUsername('app-sa@meu-projeto.iam.gserviceaccount.com')).toBe('app-sa@meu-projeto.iam');
  });
  it('follows the impersonated service account when there is one', () => {
    expect(deriveIamUsernameFor('maria@empresa.com', 'sa@p.iam.gserviceaccount.com')).toBe('sa@p.iam');
    expect(deriveIamUsernameFor('maria@empresa.com', '  ')).toBe('maria');
  });
  it('tolerates values without @', () => {
    expect(deriveIamUsername('plain')).toBe('plain');
  });
});

describe('production name guess', () => {
  it('matches pro, prod and production only', () => {
    expect(looksLikeProduction('pro')).toBe(true);
    expect(looksLikeProduction(' Prod ')).toBe(true);
    expect(looksLikeProduction('production')).toBe(true);
    expect(looksLikeProduction('hml')).toBe(false);
    expect(looksLikeProduction('Process')).toBe(false);
  });
});
