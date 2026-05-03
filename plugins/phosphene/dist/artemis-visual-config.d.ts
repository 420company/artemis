export interface ArtemisVisualConfigStatus {
    available: boolean;
    artemisHome: string;
    checkedFiles: string[];
    matchedPath?: string;
    matchedProvider?: string;
    reason: string;
}
export declare function detectArtemisVisualConfig(artemisHome?: string): ArtemisVisualConfigStatus;
export declare function assertArtemisVisualConfig(artemisHome?: string): ArtemisVisualConfigStatus;
//# sourceMappingURL=artemis-visual-config.d.ts.map