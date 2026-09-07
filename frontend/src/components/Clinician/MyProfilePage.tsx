import React from 'react'
import ClinicianProfilePage from '../Admin/ClinicianProfilePage'

/**
 * `/my-profile` — the physio's own profile.
 *
 * This is deliberately a three-line wrapper. The first cut (2026-08-24) was a
 * separately built page with its own summary tiles and its own tables, and Sam
 * called it immediately: *"baket ka pa gumawa ng sarili ui profile ng clinician,
 * diba meron na 'un ui pagination format dito"* — pointing at
 * `/admin/clinician-profile`. He was right. Two pages rendering the same three
 * tabs of the same data means every future column, filter or pagination fix has
 * to be made twice, and the second one gets forgotten.
 *
 * So the profile page is ONE component with a `selfMode` flag. Everything the
 * physio sees — the filters, the summary cards, the tables, the pagination, the
 * weekly KPI list — is the same code the super admin sees. `selfMode` removes
 * the account controls, the per-row Delete buttons and the clinician_id query
 * param, and points the KPI tab at the "my own" endpoint. The reasoning behind
 * each of those is in ClinicianProfilePage's header comment.
 *
 * The component still lives under Admin/ because that is where its main
 * audience routes in from; moving an 855-line page to gain a directory name
 * would be churn for its own sake.
 */
export default function MyProfilePage() {
  return <ClinicianProfilePage selfMode />
}

