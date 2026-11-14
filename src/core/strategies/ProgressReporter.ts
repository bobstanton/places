export class ProgressReporter {
  private onProgress?: (message: string) => void;

  constructor(onProgress?: (message: string) => void) {
    this.onProgress = onProgress;
  }

  report(percentage: number, prefix: string = "Analyzing..."): void {
    if (!this.onProgress) return;
    this.onProgress(`${prefix} ${percentage}%`);
  }

  reportPhase(_phaseName: string, startPercent: number, endPercent: number, phaseProgress: number): void {
    if (!this.onProgress) return;

    const phaseRange = endPercent - startPercent;
    const overallPercent = startPercent + (phaseProgress * phaseRange);
    const rounded = Math.round(overallPercent);

    this.onProgress(`Analyzing... ${rounded}%`);
  }
}
