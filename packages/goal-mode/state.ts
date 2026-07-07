export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	turnsUsed: number;
	maxTurns: number;
	tokensUsed: number;
	createdAt: number;
}

export type GoalUpdateStatus = "complete" | "blocked";
