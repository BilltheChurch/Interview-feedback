import { describe, it, expect } from "vitest";
import { classifyTeacherUtterance } from "../src/finalize_v2";

describe("classifyTeacherUtterance", () => {
  it("returns tier_3 for evaluative utterances > 10 char", () => {
    expect(classifyTeacherUtterance("你的分析框架很到位，逻辑清晰")).toBe(3);
    expect(classifyTeacherUtterance("That's an excellent point about the system")).toBe(3);
  });

  it("returns null for non-evaluative utterances", () => {
    expect(classifyTeacherUtterance("好的")).toBeNull();
    expect(classifyTeacherUtterance("请继续")).toBeNull();
    expect(classifyTeacherUtterance("下一题")).toBeNull();
  });

  it("returns null for short evaluative utterances", () => {
    expect(classifyTeacherUtterance("很好")).toBeNull();
    expect(classifyTeacherUtterance("不错")).toBeNull();
  });

  it("returns tier_3 for longer Chinese evaluative text", () => {
    expect(classifyTeacherUtterance("你这个回答需要改进，缺乏深入分析")).toBe(3);
    expect(classifyTeacherUtterance("这个方案分析得非常准确，值得推荐")).toBe(3);
  });

  it("returns tier_3 for longer English evaluative text", () => {
    expect(classifyTeacherUtterance("That was a very insightful analysis of the problem")).toBe(3);
    expect(classifyTeacherUtterance("Your answer needs improvement in several areas")).toBe(3);
  });

  it("returns null for long non-evaluative text", () => {
    expect(classifyTeacherUtterance("请你介绍一下你的工作经历和背景")).toBeNull();
    expect(classifyTeacherUtterance("Let me explain the next question for you now")).toBeNull();
  });
});
