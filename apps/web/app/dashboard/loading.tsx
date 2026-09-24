import { LoadingSpinner } from "../../components/loading-spinner";

export default function DashboardLoading() {
  return (
    <div className="loading-state loading-state-page">
      <LoadingSpinner label="Loading dashboard" />
    </div>
  );
}
