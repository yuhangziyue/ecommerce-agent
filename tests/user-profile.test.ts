import { describe, it, expect } from 'vitest';
import { UserProfileManager, UserProfile } from '../src/memory/user-profile.js';

describe('UserProfileManager', () => {
  it('stores a profile via setProfile and retrieves it via getProfile', () => {
    const mgr = new UserProfileManager();
    const profile: UserProfile = { userId: 'u1', name: 'Alice' };
    mgr.setProfile(profile);
    expect(mgr.getProfile('u1')).toEqual(profile);
  });

  it('returns undefined for a non-existent userId', () => {
    const mgr = new UserProfileManager();
    expect(mgr.getProfile('unknown')).toBeUndefined();
  });

  it('can update an existing profile', () => {
    const mgr = new UserProfileManager();
    mgr.setProfile({ userId: 'u1', name: 'Alice' });
    mgr.setProfile({ userId: 'u1', name: 'Alice Updated', phone: '123456' });
    const result = mgr.getProfile('u1');
    expect(result?.name).toBe('Alice Updated');
    expect(result?.phone).toBe('123456');
  });

  it('stores profiles independently for different userIds', () => {
    const mgr = new UserProfileManager();
    mgr.setProfile({ userId: 'u1', name: 'Alice' });
    mgr.setProfile({ userId: 'u2', name: 'Bob' });
    expect(mgr.getProfile('u1')?.name).toBe('Alice');
    expect(mgr.getProfile('u2')?.name).toBe('Bob');
  });

  it('handles optional fields: preferences and history', () => {
    const mgr = new UserProfileManager();
    const profile: UserProfile = {
      userId: 'u3',
      preferences: { theme: 'dark', lang: 'zh' },
      history: ['order-001', 'order-002'],
    };
    mgr.setProfile(profile);
    const result = mgr.getProfile('u3');
    expect(result?.preferences).toEqual({ theme: 'dark', lang: 'zh' });
    expect(result?.history).toEqual(['order-001', 'order-002']);
  });
});
