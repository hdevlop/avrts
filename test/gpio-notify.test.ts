import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Gpio's pin watchers share one computed level byte per notification. A listener that
// changes another pin of the same port notifies again from inside the first
// notification; the watchers after it must then see the new level, not the old byte.
describe("pin change notification", () => {
  test("a listener that changes a later pin of the same port reports each change once", () => {
    const avr = AVR();
    const events: string[] = [];
    avr.pin(8).onChange((high) => {
      events.push(`8:${high}`);
      if (high) avr.pin(9).setInput(true);
    });
    avr.pin(9).onChange((high) => events.push(`9:${high}`));
    avr.pin(8).setInput(true);
    expect(events).toEqual(["8:true", "9:true"]);
    expect(avr.pin(9).read()).toBe(true);
  });

  test("a listener that changes an earlier pin of the same port reports each change once", () => {
    const avr = AVR();
    avr.pin(8).setInput(true);
    const events: string[] = [];
    avr.pin(8).onChange((high) => events.push(`8:${high}`));
    avr.pin(9).onChange((high) => {
      events.push(`9:${high}`);
      if (high) avr.pin(8).setInput(false);
    });
    avr.pin(9).setInput(true);
    expect(events).toEqual(["9:true", "8:false"]);
    avr.pin(9).setInput(false);
    expect(events).toEqual(["9:true", "8:false", "9:false"]);
  });

  test("unsubscribing during a notification keeps that notification's subscribers", () => {
    const avr = AVR();
    const events: string[] = [];
    let stopNine = () => {};
    avr.pin(8).onChange((high) => {
      events.push(`8:${high}`);
      stopNine();
    });
    stopNine = avr.pin(9).onChange((high) => events.push(`9:${high}`));
    avr.pin(8).setInput(true);
    avr.pin(9).setInput(true);
    expect(events).toEqual(["8:true"]);
  });
});
