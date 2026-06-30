# M1 AnythingLLM OCR + Local VLM True-Ingest Baseline

## Settings

- API base: `http://localhost:3101/api`
- Workspace: `m1-vlm-enriched-baseline-vlm-first`
- Corpus items uploaded: 216/216
- Query topN: 20; reported recall: R@1/R@3/R@5; MRR uses first relevant rank within top20.
- Ingest path: real AnythingLLM upload API and collector; image files embed local Ollama VLM description plus Tesseract OCR text.

## Summary

| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 |
|---|---:|---:|---:|---:|---:|---:|
| all | 28 | 0.571 | 0.786 | 0.857 | 0.703 | 4 |
| pure_visual | 13 | 0.462 | 0.615 | 0.769 | 0.585 | 3 |
| text_or_ocr | 15 | 0.667 | 0.933 | 0.933 | 0.806 | 1 |

## By Category

| category | queries | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|---:|
| chat_text | 3 | 1.000 | 1.000 | 1.000 | 1.000 |
| mixed_visual | 3 | 0.333 | 0.667 | 0.667 | 0.524 |
| ocr_ui | 1 | 1.000 | 1.000 | 1.000 | 1.000 |
| ocr_web | 2 | 0.500 | 1.000 | 1.000 | 0.750 |
| pdf_document | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| pure_visual_photo | 5 | 0.800 | 0.800 | 1.000 | 0.850 |
| pure_visual_ui | 1 | 0.000 | 0.000 | 1.000 | 0.200 |
| receipt_ocr | 1 | 0.000 | 0.000 | 0.000 | 0.083 |
| text_document | 4 | 0.750 | 1.000 | 1.000 | 0.875 |
| visual_plus_text_ui | 1 | 0.000 | 1.000 | 1.000 | 0.500 |
| visual_receipt | 1 | 0.000 | 0.000 | 0.000 | 0.083 |
| visual_scanned_form | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| visual_text_scene | 1 | 0.000 | 1.000 | 1.000 | 0.500 |
| visual_ui | 2 | 0.500 | 1.000 | 1.000 | 0.750 |

## Query Rows

| id | pure_visual | rank | top5 |
|---|---:|---:|---|
| q01_black_cat_sink | true | 1 | coco_284623, coco_117908, coco_304560, coco_115885, coco_427034 |
| q02_black_cat_grass | true | 1 | coco_304560, coco_115885, coco_229221, coco_284623, coco_116825 |
| q03_camera_next_to_phone | true | 4 | coco_480212, real_image_text_001, coco_259597, coco_446207, coco_427034 |
| q04_child_recording_stage | true | 1 | coco_259597, real_image_text_001, coco_14226, coco_110449, doc_phone_backup |
| q05_two_men_ties | true | 1 | coco_423506, coco_113720, real_image_text_010, coco_110449, real_image_text_028 |
| q06_rocket_clouds_page | true | 5 | coco_388258, real_ui_screenshot_016, real_ui_screenshot_021, real_ui_screenshot_013, real_ui_screenshot_001 |
| q07_bitly_cartoon | true | 1 | real_ui_screenshot_009, real_ui_screenshot_017, real_ui_screenshot_003, real_ui_screenshot_029, real_ui_screenshot_021 |
| q08_airtable_collaboration | true | 2 | real_ui_screenshot_016, real_ui_screenshot_013, real_ui_screenshot_021, real_image_text_010, real_ui_screenshot_003 |
| q09_keyboard_continue_button | false | 2 | real_image_text_024, real_image_text_023, doc_desk_setup, coco_541664, coco_115885 |
| q10_harry_potter_book_page | false | 2 | real_image_text_030, real_image_text_029, real_image_text_022, text_pdfjs_firefox, real_ui_screenshot_014 |
| q11_red_stamp_receipt | true | 12 | real_receipt_006, real_receipt_002, real_receipt_012, real_receipt_013, real_receipt_009 |
| q12_red_stamp_form | true | miss | text_funsd_0001463448, real_receipt_002, real_receipt_012, real_receipt_013, chat_home_repair |
| q13_wikipedia_mobile | false | 1 | text_mobile_aloha_iphone, text_browser_floorp, text_web_wikipedia_mobile_ecosia, real_ui_screenshot_029, text_browser_beaker_wikipedia |
| q14_liberapay_feed | false | 1 | text_web_nitter_liberapay, real_ui_screenshot_027, real_chart_009, text_mobile_firefox_commons_tools, real_chart_010 |
| q15_floorp_browser | false | 2 | real_ui_screenshot_021, text_browser_floorp, real_ui_screenshot_014, real_ui_screenshot_005, real_ui_screenshot_002 |
| q16_receipt_total | false | 12 | real_receipt_006, real_receipt_002, real_receipt_009, real_receipt_007, real_receipt_013 |
| q17_apartment_keys | false | 1 | doc_apartment_move_checklist, real_receipt_006, doc_rental_car, real_image_text_026, coco_112626 |
| q18_bike_brake_pads | false | 1 | doc_bike_repair_quote, coco_388258, coco_135670, real_image_text_013, coco_534673 |
| q19_router_mesh_node | false | 1 | doc_home_router, real_image_text_022, coco_112626, doc_apartment_move_checklist, real_image_text_026 |
| q20_pdf_signature_area | false | 1 | pdf_public_demo_agreement, text_pdfjs_firefox, text_funsd_0001463448, real_receipt_002, real_ui_screenshot_003 |
| q21_ui_error_box | false | 1 | chat_ui_bug, chat_home_repair, real_ui_screenshot_003, text_mobile_firefox_commons_tools, real_ui_screenshot_014 |
| q22_blue_couch_map_pin | false | 1 | chat_trip_planning, chat_ui_bug, chat_home_repair, real_ui_screenshot_014, coco_110449 |
| q23_local_ocr_vlm | false | 1 | chat_receipt_cleanup, real_receipt_012, real_receipt_002, real_receipt_013, chat_home_repair |
| q24_laptop_and_keyboard | true | 2 | coco_324715, real_image_text_023, coco_115885, real_image_text_024, coco_480212 |
| q25_phone_in_photo | true | 1 | coco_480212, doc_photo_archive_notes, real_image_text_001, coco_259597, coco_135410 |
| q26_visual_receipt_or_ticket | true | 14 | real_receipt_002, real_receipt_013, real_receipt_003, real_receipt_009, real_receipt_006 |
| q27_device_return_pdf | false | 1 | pdf_device_return_form, text_pdfjs_firefox, pdf_event_ticket_note, real_ui_screenshot_002, pdf_public_demo_agreement |
| q28_team_lunch | false | 2 | coco_132116, doc_team_lunch, coco_104669, coco_120853, coru_receipt_009 |
