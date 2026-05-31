import { create } from 'zustand';

export type AppPage =
  | 'dashboard'                // ADMIN: existing Nookal CEO dashboard (table view)
  | 'admin-ceo-analytics'      // ADMIN: executive analytics view of Nookal data
  | 'admin-users'              // ADMIN: user management
  | 'admin-dropouts'           // ADMIN: consolidated dropout view
  | 'admin-dropout-analytics'  // ADMIN: dropout trend + breakdowns
  | 'admin-case-acceptance'    // ADMIN: consolidated case acceptance view
  | 'admin-activity-log'       // ADMIN: audit log viewer
  | 'dropout-entry'            // CLINICIAN / FRONT_DESK: dropout input form
  | 'case-acceptance-entry'    // CLINICIAN / FRONT_DESK: case acceptance input form
  | 'ad-spend-entry';          // ADSPEND: ad spend input form (only page this role sees)

interface NavState {
  page: AppPage;
  navigate: (p: AppPage) => void;
}

export const useNavStore = create<NavState>((set) => ({
  page: 'dashboard',
  navigate: (page) => set({ page }),
}));
