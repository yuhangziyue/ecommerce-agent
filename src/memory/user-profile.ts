export interface UserProfile {
  userId: string;
  name?: string;
  phone?: string;
  preferences?: Record<string, unknown>;
  history?: string[];
}

export class UserProfileManager {
  private profiles: Map<string, UserProfile> = new Map();

  getProfile(userId: string): UserProfile | undefined {
    return this.profiles.get(userId);
  }

  setProfile(profile: UserProfile): void {
    this.profiles.set(profile.userId, profile);
  }
}
