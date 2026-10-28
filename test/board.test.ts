import { describe, expect, it } from "vitest";
import { Workboard } from "../src/workboard/board";

describe("workboard", () => {
  it("依赖未完成时不能进入进行中或已完成", () => {
    const board = new Workboard("r");
    const first = board.create({ title: "调研", createdBy: "user" });
    const second = board.create({ title: "写作", createdBy: "user", deps: [first.id] });

    expect(() => board.update(second.id, { status: "doing" })).toThrow(/未完成依赖/);

    board.update(first.id, { status: "done" });
    expect(board.update(second.id, { status: "doing" }).status).toBe("doing");
  });

  it("成果登记会累积到任务卡", () => {
    const board = new Workboard("r");
    const task = board.create({ title: "调研", createdBy: "user" });
    board.attachArtifact(task.id, { name: "report.md", path: "artifacts/report.md", addedBy: "m_a" });
    const updated = board.attachArtifact(task.id, { name: "data.csv", addedBy: "m_a" });
    expect(updated.artifacts.map((artifact) => artifact.name)).toEqual(["report.md", "data.csv"]);
  });
});
