import { useState, type ComponentProps } from 'react'
import { LayoutDashboard, LineChart } from 'lucide-react'
import Reports from './Reports'
import CustomReports from './custom/CustomReports'

const TAB_KEY = 'ba.reports.tab'
type Tab = 'overview' | 'custom'

/** Reports: the ready-made overview, and the reports people build themselves. */
export default function ReportsHome(props: ComponentProps<typeof Reports> & { canUseTrackers: boolean }) {
  const { canUseTrackers, ...overview } = props
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === 'custom' ? 'custom' : 'overview'
    } catch {
      return 'overview'
    }
  })
  const choose = (next: Tab) => {
    setTab(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // Not remembered in private windows.
    }
  }
  return (
    <div className="reports-home">
      <div className="reports-tabs" role="tablist" aria-label="Reports">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'overview'}
          className={tab === 'overview' ? 'on' : ''}
          onClick={() => choose('overview')}
        >
          <LineChart size={15} /> Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'custom'}
          className={tab === 'custom' ? 'on' : ''}
          onClick={() => choose('custom')}
        >
          <LayoutDashboard size={15} /> Custom reports
        </button>
      </div>
      {tab === 'overview' ? <Reports {...overview} /> : <CustomReports {...overview} canUseTrackers={canUseTrackers} />}
    </div>
  )
}
