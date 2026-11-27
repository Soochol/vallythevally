// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { ColorStylePopover } from "./ColorStylePopover";

beforeEach(() => {
  installDomShims();
});

resetDomAfterEach();

function Harness({ onColorChange }: { onColorChange(hex: string): void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">열기</button>
      <ColorStylePopover
        trigger={anchor}
        label="테스트 색"
        value="#FF0000"
        theme={[]}
        width={2}
        onColorChange={onColorChange}
        onWidthChange={() => {}}
        onClose={() => {}}
      />
    </>
  );
}

test("ColorStylePopover SV 피커는 화살표 키로 채도와 밝기를 조절한다", () => {
  const onColorChange = vi.fn();
  render(<Harness onColorChange={onColorChange} />);

  fireEvent.click(screen.getByRole("button", { name: "직접 고르기" }));
  const sv = screen.getByRole("group", { name: "채도와 밝기. 화살표로 조절" });

  fireEvent.keyDown(sv, { key: "ArrowLeft", shiftKey: true });
  fireEvent.keyDown(sv, { key: "ArrowDown", shiftKey: true });

  expect(onColorChange).toHaveBeenCalledTimes(2);
  expect(onColorChange.mock.calls[0]![0]).not.toBe("#FF0000");
  expect(onColorChange.mock.calls[1]![0]).not.toBe(onColorChange.mock.calls[0]![0]);
});
