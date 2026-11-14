import { Coordinate, DistanceCalculator } from "places-shared/worker-safe";

interface DPWorkItem {
  startIndex: number;
  endIndex: number;
}

export class CoordinateSimplifier {
  static simplify(coordinates: Coordinate[], tolerance: number = 0.00005): Coordinate[] {
    if (coordinates.length <= 2) {
      return [...coordinates];
    }

    const keep = new Set<number>();

    keep.add(0);
    keep.add(coordinates.length - 1);

    const workStack: DPWorkItem[] = [{ startIndex: 0, endIndex: coordinates.length - 1 }];

    while (workStack.length > 0) {
      const { startIndex, endIndex } = workStack.pop()!;

      let maxDistance = 0;
      let maxIndex = 0;
      const first = coordinates[startIndex];
      const last = coordinates[endIndex];

      for (let i = startIndex + 1; i < endIndex; i++) {
        const distance = DistanceCalculator.perpendicularDistanceDegrees(coordinates[i], first, last);

        if (distance > maxDistance) {
          maxDistance = distance;
          maxIndex = i;
        }
      }

      if (maxDistance > tolerance) {
        keep.add(maxIndex);

        if (maxIndex - startIndex > 1) {
          workStack.push({ startIndex, endIndex: maxIndex });
        }

        if (endIndex - maxIndex > 1) {
          workStack.push({ startIndex: maxIndex, endIndex });
        }
      }
    }

    const keptIndices = Array.from(keep).sort((a, b) => a - b);

    return keptIndices.map(i => coordinates[i]);
  }

  static simplifyToMaxPoints(coordinates: Coordinate[], maxPoints: number, tolerance: number = 0.00005): Coordinate[] {
    if (coordinates.length <= maxPoints) {
      return coordinates;
    }

    let result = this.simplify(coordinates, tolerance);

    if (result.length > maxPoints) {
      result = this.uniformSubsample(result, maxPoints);
    }

    return result;
  }

  static uniformSubsample(coordinates: Coordinate[], maxPoints: number): Coordinate[] {
    if (coordinates.length <= maxPoints) return coordinates;

    const step = coordinates.length / maxPoints;
    const result: Coordinate[] = [coordinates[0]];

    for (let i = 1; i < maxPoints - 1; i++) {
      const index = Math.round(i * step);

      if (index < coordinates.length && index !== 0) {
        result.push(coordinates[index]);
      }
    }

    if (coordinates.length > 1) {
      result.push(coordinates[coordinates.length - 1]);
    }

    return result;
  }
}
