import { Link } from "react-router";
import { BrandIcon } from "../icons";
import { pathOfPage } from "./pages";

export function BrandLink() {
  return (
    <Link to={pathOfPage("home")} className="app-brand" title="vally 랜딩 페이지로 이동">
      <BrandIcon />
      <span>vally</span>
    </Link>
  );
}
