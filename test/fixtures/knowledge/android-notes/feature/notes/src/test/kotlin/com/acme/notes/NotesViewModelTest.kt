package com.acme.notes

import org.junit.Assert.assertEquals
import org.junit.Test

class NotesViewModelTest {
    @Test
    fun `rejects blank titles`() {
        val viewModel = NotesViewModel(FakeRepository())
        viewModel.save("", "body")
        assertEquals("Title is required", viewModel.error)
    }
}
