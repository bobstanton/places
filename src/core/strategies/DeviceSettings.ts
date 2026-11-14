export interface DeviceOptimalSettings {
  targetPointsPerTrack: number;
  simplificationTolerance: number;
}

const MOBILE_SETTINGS: DeviceOptimalSettings = {
  targetPointsPerTrack: 100,
  simplificationTolerance: 0.0001  
};

const DESKTOP_SETTINGS: DeviceOptimalSettings = {
  targetPointsPerTrack: 200,
  simplificationTolerance: 0.00005  
};

export function getDeviceOptimalSettings(isMobile: boolean): DeviceOptimalSettings {
  return isMobile ? MOBILE_SETTINGS : DESKTOP_SETTINGS;
}
